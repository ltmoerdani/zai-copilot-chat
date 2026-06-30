/**
 * Direct HTTP client for Z.AI MCP Streamable HTTP endpoints.
 *
 * This module calls the Z.AI Web Search and Web Reader MCP servers **directly**
 * via `fetch()` — without registering them with VS Code's MCP infrastructure.
 *
 * Why direct HTTP instead of `vscode.lm.invokeTool`?
 * - `vscode.lm.invokeTool` requires the MCP server to be registered (either
 *   via `mcp.json` or `mcpServerDefinitionProvider`). Both approaches make
 *   the tools visible to Copilot Agent, which then invokes them during
 *   regular chat and gets stuck on slow MCP calls.
 * - By calling the HTTP endpoint directly, the tools are completely invisible
 *   to VS Code's tool infrastructure. Only `@z-research` can invoke them.
 *
 * The Z.AI MCP servers use the Streamable HTTP transport:
 *   POST https://api.z.ai/api/mcp/web_search_prime/mcp
 *   Content-Type: application/json
 *   Authorization: Bearer <api-key>
 *   Accept: application/json, text/event-stream
 *
 * The request body is a JSON-RPC 2.0 `tools/call` message.
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
  extractReadResult,
  extractSearchResults,
} from "./mcpResponseParser";
import type {
  ZaiReadResult,
  ZaiSearchResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 2;
const BASE_BACKOFF_MS = 1_000;

const MCP_WEB_SEARCH_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const MCP_WEB_READER_URL = "https://api.z.ai/api/mcp/web_reader/mcp";
const SECRET_KEY = "zai.apiKey";

export interface McpToolInvokerOptions {
  webSearchToolName: string;
  webReaderToolName: string;
  outputChannel?: vscode.OutputChannel;
  secrets: vscode.SecretStorage;
}

export class McpToolInvoker {
  constructor(private readonly options: McpToolInvokerOptions) {}

  private log(message: string): void {
    this.options.outputChannel?.appendLine(
      `[${new Date().toISOString()}] [mcp-tools] ${message}`,
    );
  }

  private async getApiKey(): Promise<string> {
    const key = await this.options.secrets.get(SECRET_KEY);
    if (!key) {
      throw new Error(
        "Z.AI API key is required. Use 'Z.AI: Set API Key' first.",
      );
    }
    return key;
  }

  /**
   * Call a Z.AI MCP tool via direct HTTP (Streamable HTTP transport).
   * Sends a JSON-RPC `tools/call` request and parses the response.
   */
  private async callMcpTool(
    endpoint: string,
    toolName: string,
    input: Record<string, unknown>,
    timeoutMs: number,
    label: string,
  ): Promise<string> {
    const apiKey = await this.getApiKey();

    // JSON-RPC 2.0 tools/call request
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: input,
      },
    });

    const fetchPromise = fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      // The response can be application/json or text/event-stream (SSE).
      // For Streamable HTTP, the JSON-RPC response is in the SSE data field.
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return this.parseSseResponse(response);
      }
      return response.text();
    });

    return withTimeout(fetchPromise, timeoutMs, label);
  }

  /**
   * Parse a Server-Sent Events response from the MCP server.
   * Extracts the JSON-RPC response from the `data:` lines.
   */
  private async parseSseResponse(
    response: Response,
  ): Promise<string> {
    const text = await response.text();
    // SSE format: lines starting with "data:" contain JSON
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    // Find the JSON-RPC response (has "result" or "error")
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.result || parsed.error) {
          return line;
        }
      } catch {
        // Not JSON, skip
      }
    }
    // Fallback: return the raw text
    return text;
  }

  /**
   * Call the Web Search MCP tool.
   * Retries with exponential backoff on rate-limit errors.
   */
  async webSearch(
    query: string,
    count = 10,
    _token?: vscode.ChatParticipantToolToken,
    maxRetries = DEFAULT_RETRY_COUNT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ZaiSearchResult[]> {
    let attempt = 0;
    while (true) {
      attempt++;
      this.log(
        `webSearch (search_query="${query}", count=${count}, attempt=${attempt})`,
      );
      try {
        const raw = await this.callMcpTool(
          MCP_WEB_SEARCH_URL,
          this.options.webSearchToolName,
          buildWebSearchInput(query, count),
          timeoutMs,
          `webSearch("${query.slice(0, 60)}")`,
        );

        if (isRateLimitError(raw)) {
          throw new RateLimitError("Rate limit reached", raw);
        }

        const results = extractSearchResults(raw);
        if (results.length === 0) {
          this.log(
            `webSearch: 0 results. First 200 chars: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
          );
        }
        return results;
      } catch (error) {
        if (error instanceof TimeoutError) {
          this.log(`Timeout (${timeoutMs}ms) for search "${query}" — skipping`);
          return [];
        }
        if (error instanceof RateLimitError && attempt <= maxRetries) {
          const delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
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
   * Call the Web Reader MCP tool.
   * Returns a stub on timeout so the orchestrator can continue.
   */
  async webRead(
    url: string,
    format: "markdown" | "text" = "markdown",
    _token?: vscode.ChatParticipantToolToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ZaiReadResult> {
    this.log(`webRead (url=${url}, format=${format})`);
    try {
      const raw = await this.callMcpTool(
        MCP_WEB_READER_URL,
        this.options.webReaderToolName,
        buildWebReadInput(url, format),
        timeoutMs,
        `webRead("${url.slice(0, 80)}")`,
      );
      return extractReadResult(raw, url);
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.log(`Timeout (${timeoutMs}ms) for read ${url} — returning stub`);
        return { url, content: "" };
      }
      throw error;
    }
  }

  /**
   * Check if the MCP tools are ready (API key is set).
   * No longer checks `vscode.lm.tools` since we call HTTP directly.
   */
  async isReady(): Promise<boolean> {
    try {
      await this.getApiKey();
      return true;
    } catch {
      return false;
    }
  }
}
