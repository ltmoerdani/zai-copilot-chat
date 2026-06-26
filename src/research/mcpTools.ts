/**
 * Thin wrapper around `vscode.lm.invokeTool` for the Z.AI MCP tools.
 *
 * VS Code exposes MCP-registered tools through the same `invokeTool` API as
 * native extension tools. The orchestrator uses this helper to call
 * `webSearchPrime` and `webReader` without re-implementing the MCP protocol.
 *
 * The MCP tool name passed in should be the bare name reported by the MCP
 * server (e.g. `webSearchPrime`, `webReader`). If the tool is not yet
 * connected or VS Code exposes it with a server prefix, the caller can pass
 * the fully-qualified name directly.
 */

import * as vscode from "vscode";

import {
  buildWebReadInput,
  buildWebSearchInput,
} from "./mcpInputBuilders";
import {
  isRateLimitError,
  RateLimitError,
  sleep,
} from "./mcpRateLimit";
import { TimeoutError, withTimeout } from "./mcpTimeout";
import {
  camelToSnake,
  resolveToolName,
} from "./mcpToolNameResolver";
import {
  extractReadResult,
  extractSearchResults,
} from "./mcpResponseParser";
import type {
  ZaiReadResult,
  ZaiSearchResult,
} from "./types";

/** Default per-call timeout for MCP tool invocations (30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default retry budget for rate-limit errors per call. */
const DEFAULT_RETRY_COUNT = 2;

/** Backoff base — actual delay is `BASE_BACKOFF_MS * 2^(attempt-1)`. */
const BASE_BACKOFF_MS = 1_000;

export interface McpToolInvokerOptions {
  webSearchToolName: string;
  webReaderToolName: string;
  outputChannel?: vscode.OutputChannel;
}

export class McpToolInvoker {
  /** Cache of resolved tool names to avoid scanning `vscode.lm.tools` per call. */
  private readonly nameCache = new Map<string, string | undefined>();

  /**
   * Test seam: when non-null, `resolveToolName` reads from this list
   * instead of `vscode.lm.tools`. Used by the unit tests to exercise the
   * resolution algorithm without the VS Code runtime.
   */
  private mockTools: ReadonlyArray<{ name: string }> | undefined;

  constructor(private readonly options: McpToolInvokerOptions) {}

  /** @internal — test seam. Returns a new invoker with a mocked tool list. */
  withMockTools(tools: ReadonlyArray<{ name: string }> | string[]): McpToolInvoker {
    const next = new McpToolInvoker(this.options);
    next.mockTools = tools.map((t) =>
      typeof t === "string" ? { name: t } : t,
    );
    return next;
  }

  /** @internal — test seam. Calls the private resolver. */
  resolveForTest(preferred: string): string | undefined {
    return this.resolveToolName(preferred);
  }

  private log(message: string): void {
    this.options.outputChannel?.appendLine(
      `[${new Date().toISOString()}] [mcp-tools] ${message}`,
    );
  }

  /**
   * Resolve the tool name VS Code actually exposes.
   *
   * MCP tools can appear under several naming patterns, with mixed case:
   *   - `webSearchPrime`                              (bare camelCase)
   *   - `web_search_prime`                            (bare snake_case)
   *   - `zai-web-search-prime.webSearchPrime`         (server.tool dot)
   *   - `zai-web-search-prime__web_search_prime`      (server__tool dunder)
   *   - `mcp_zai-web-searc_web_search_prime`          (truncated, snake)
   *
   * We try exact match first, then progressively relax: snake↔camel case
   * conversion, then substring match. The resolved name is cached so each
   * call is cheap.
   */
  private resolveToolName(preferred: string): string | undefined {
    return resolveToolName(preferred, this.mockTools ?? vscode.lm.tools, this.nameCache);
  }

  /** List all tools currently available to the extension. */
  listAvailableTools(): string[] {
    return vscode.lm.tools.map((t) => t.name);
  }

  /** @internal — test seam. Exposes the pure case converter. */
  camelToSnakeForTest(s: string): string {
    return camelToSnake(s);
  }

  /**
   * Call the Web Search MCP tool. The Z.AI MCP server expects:
   *   - `search_query` (string, required)
   *   - `count` (number, 1-50, optional)
   * Other parameters like `search_engine` and `search_recency_filter` are
   * managed server-side (or via tool metadata).
   *
   * Each attempt is wrapped in a per-call timeout (`timeoutMs`, default
   * 30s). On rate-limit errors, retries with exponential backoff up to
   * `maxRetries` times. Other errors propagate immediately.
   *
   * @param token Optional `ChatParticipantToolToken` from the originating
   *   chat request. When provided, VS Code treats the call as
   *   user-authorised and skips the confirmation modal.
   */
  async webSearch(
    query: string,
    count = 10,
    token?: vscode.ChatParticipantToolToken,
    maxRetries = 2,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ZaiSearchResult[]> {
    const toolName = this.resolveToolName(this.options.webSearchToolName);
    if (!toolName) {
      throw new Error(
        `Z.AI Web Search tool ('${this.options.webSearchToolName}') is not available. ` +
          "Make sure the MCP servers are connected (check the MCP view in VS Code).",
      );
    }

    let attempt = 0;
    while (true) {
      attempt++;
      this.log(
        `invoking ${toolName} (search_query="${query}", count=${count}, attempt=${attempt})`,
      );
      try {
        const result = await withTimeout(
          vscode.lm.invokeTool(toolName, {
            input: buildWebSearchInput(query, count),
            toolInvocationToken: token,
          }),
          timeoutMs,
          `webSearch("${query.slice(0, 60)}")`,
        );
        return this.parseSearchResult(result);
      } catch (error) {
        if (error instanceof TimeoutError) {
          this.log(
            `Timeout (${timeoutMs}ms) for search "${query}" — giving up on this query`,
          );
          return []; // fail-soft: a hung query must not block the whole run
        }
        if (error instanceof RateLimitError && attempt <= maxRetries) {
          const delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s
          this.log(
            `Rate limit hit for "${query}", backing off ${delayMs}ms (attempt ${attempt}/${maxRetries})`,
          );
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Call the Web Reader MCP tool. Expects `url` (required) and
   * `return_format` (markdown | text, optional).
   *
   * Wrapped in a per-call timeout (default 30s). On timeout, returns a
   * stub result with the URL so the orchestrator can continue.
   *
   * @param token Optional chat token; see {@link webSearch}.
   */
  async webRead(
    url: string,
    format: "markdown" | "text" = "markdown",
    token?: vscode.ChatParticipantToolToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ZaiReadResult> {
    const toolName = this.resolveToolName(this.options.webReaderToolName);
    if (!toolName) {
      throw new Error(
        `Z.AI Web Reader tool ('${this.options.webReaderToolName}') is not available. ` +
          "Make sure the MCP servers are connected (check the MCP view in VS Code).",
      );
    }

    this.log(`invoking ${toolName} (url=${url}, format=${format})`);

    try {
      const result = await withTimeout(
        vscode.lm.invokeTool(toolName, {
          input: buildWebReadInput(url, format),
          toolInvocationToken: token,
        }),
        timeoutMs,
        `webRead("${url.slice(0, 80)}")`,
      );
      return this.parseReadResult(result, url);
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.log(
          `Timeout (${timeoutMs}ms) for read ${url} — returning stub`,
        );
        return { url, content: "" }; // fail-soft: empty content, not a crash
      }
      throw error;
    }
  }

  /** Test whether both MCP tools are currently available. */
  isReady(): boolean {
    const searchName = this.resolveToolName(this.options.webSearchToolName);
    const readerName = this.resolveToolName(this.options.webReaderToolName);
    const ready = searchName !== undefined && readerName !== undefined;
    if (!ready) {
      const available = this.listAvailableTools();
      this.log(
        `MCP tools not ready. Looking for: "${this.options.webSearchToolName}", ` +
          `"${this.options.webReaderToolName}". ` +
          `Resolved: search=${searchName ?? "—"}, reader=${readerName ?? "—"}. ` +
          `Available tools (${available.length}): ${available.join(", ") || "(none)"}`,
      );
    }
    return ready;
  }

  // ---- parsers ----------------------------------------------------------

  /**
   * Defensive parser for the MCP web search result. The MCP server returns
   * its payload inside the standard `LanguageModelToolResult.content`
   * array. We delegate to the pure parser in `mcpResponseParser.ts` and
   * log the raw text for diagnosis if nothing was extracted.
   *
   * Throws {@link RateLimitError} if the response indicates the Z.AI
   * rate limit was hit (HTTP 429 / error code 1302). The caller is
   * expected to retry with backoff.
   */
  private parseSearchResult(result: vscode.LanguageModelToolResult): ZaiSearchResult[] {
    const texts = this.collectTextParts(result);
    for (const text of texts) {
      if (isRateLimitError(text)) {
        throw new RateLimitError("Z.AI MCP search: rate limit reached", text);
      }
      const got = extractSearchResults(text);
      if (got.length > 0) return got;
    }
    if (texts.length > 0) {
      this.log(
        `parseSearchResult: 0 results from ${texts.length} text part(s). ` +
          `First 200 chars: ${texts[0].slice(0, 200).replace(/\s+/g, " ")}`,
      );
    } else {
      this.log(`parseSearchResult: no text parts in result content`);
    }
    return [];
  }

  /**
   * Defensive parser for the MCP web reader result. Falls back to the raw
   * text body if no JSON structure is recognised.
   */
  private parseReadResult(
    result: vscode.LanguageModelToolResult,
    requestedUrl: string,
  ): ZaiReadResult {
    const texts = this.collectTextParts(result);
    for (const text of texts) {
      const got = extractReadResult(text, requestedUrl);
      if (got.content) return got;
    }
    // Fallback: return the raw first text as the body.
    if (texts.length > 0) {
      return { url: requestedUrl, content: texts[0] };
    }
    return { url: requestedUrl, content: "" };
  }

  /** Pull every text segment out of a `LanguageModelToolResult`. */
  private collectTextParts(result: vscode.LanguageModelToolResult): string[] {
    const out: string[] = [];
    for (const part of result.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        out.push(part.value);
      }
    }
    return out;
  }
}

// Re-export for convenience so existing `import { RateLimitError } from
// "./mcpTools"` continues to work.
export { RateLimitError } from "./mcpRateLimit";
