/**
 * Language Model Tool: `zai_webSearch`.
 *
 * Wraps Z.AI Web Search API so Copilot Agent mode (and `#zai-search` prompt
 * references) can perform web searches. The tool returns a compact JSON array
 * of results — Copilot can then decide to call `zai_webRead` for full content.
 */

import * as vscode from "vscode";
import { ZaiApiClient } from "./zaiApiClient";
import {
  MissingApiKeyError,
  ZaiApiError,
  type WebSearchInput,
  type ZaiSearchResult,
} from "./types";

/** Cap on results returned per call — keeps token usage reasonable. */
const MAX_RESULTS_PER_CALL = 20;

export class ZaiWebSearchTool
  implements vscode.LanguageModelTool<WebSearchInput> {
  constructor(
    /** Factory so the tool always picks up the latest client instance. */
    private readonly clientProvider: () => Promise<ZaiApiClient>,
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WebSearchInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const query = options.input.query?.trim();
    if (!query) {
      return {
        invocationMessage: "Z.AI Web Search",
        confirmationMessages: {
          title: "Z.AI Web Search",
          message:
            "Cannot search: the query is empty. Ask the model to provide a search query.",
        },
      };
    }

    const count = Math.min(
      Math.max(1, options.input.count ?? 10),
      MAX_RESULTS_PER_CALL,
    );

    return {
      invocationMessage: `Searching the web: "${query}"`,
      confirmationMessages: {
        title: "Z.AI Web Search",
        message: new vscode.MarkdownString(
          `Search the web for **${query}** (up to ${count} results) via Z.AI?`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WebSearchInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const client = await this.clientProvider();
      const query = options.input.query.trim();
      const count = Math.min(
        Math.max(1, options.input.count ?? 10),
        MAX_RESULTS_PER_CALL,
      );

      const results = await client.webSearch(query, count);
      return this.formatResults(query, results);
    } catch (error) {
      return this.formatError(error);
    }
  }

  /** Render search results as a compact, LLM-friendly text block. */
  private formatResults(
    query: string,
    results: ZaiSearchResult[],
  ): vscode.LanguageModelToolResult {
    if (results.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No web search results found for "${query}". Try a different query or use \`zai_webRead\` on a known URL.`,
        ),
      ]);
    }

    const lines: string[] = [
      `Found ${results.length} web result(s) for "${query}":`,
      "",
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   URL: ${r.url}`);
      if (r.snippet) {
        // Truncate long snippets to keep the tool response compact.
        const snippet = r.snippet.length > 400 ? `${r.snippet.slice(0, 400)}…` : r.snippet;
        lines.push(`   ${snippet}`);
      }
      if (r.source) {
        lines.push(`   Source: ${r.source}`);
      }
      lines.push("");
    }

    lines.push(
      "Tip: call `zai_webRead` with any URL above to retrieve the full page content.",
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(lines.join("\n")),
    ]);
  }

  /** Convert errors into messages the LLM can act on. */
  private formatError(error: unknown): vscode.LanguageModelToolResult {
    let message: string;
    if (error instanceof MissingApiKeyError) {
      message =
        "Z.AI Web Search failed: no API key configured. Ask the user to run " +
        "'Z.AI: Set API Key' from the command palette.";
    } else if (error instanceof ZaiApiError) {
      message = `Z.AI Web Search failed (HTTP ${error.status}): ${error.message}`;
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      message = `Z.AI Web Search failed: ${detail}`;
    }
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(message),
    ]);
  }
}
