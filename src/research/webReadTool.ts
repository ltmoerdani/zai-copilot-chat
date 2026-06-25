/**
 * Language Model Tool: `zai_webRead`.
 *
 * Wraps Z.AI Web Reader API. Returns the extracted main content of a URL as
 * clean markdown, so Copilot can reason about the page without the noise of
 * navigation, ads, or boilerplate. Server-side extraction means no headless
 * browser is bundled with the extension.
 */

import * as vscode from "vscode";
import { ZaiApiClient } from "./zaiApiClient";
import {
  MissingApiKeyError,
  ZaiApiError,
  type WebReadInput,
} from "./types";

/**
 * Approximate character cap on returned content. ~100K chars ≈ 25K tokens,
 * which keeps a single tool response well within Copilot's per-turn budget.
 * Longer content should be handled by the orchestrator in Part B.
 */
const MAX_CONTENT_CHARS = 100_000;

export class ZaiWebReadTool
  implements vscode.LanguageModelTool<WebReadInput> {
  constructor(
    private readonly clientProvider: () => Promise<ZaiApiClient>,
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WebReadInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const url = options.input.url?.trim();
    if (!url || !this.isValidUrl(url)) {
      return {
        invocationMessage: "Z.AI Web Reader",
        confirmationMessages: {
          title: "Z.AI Web Reader",
          message:
            "Cannot read: a valid absolute URL (http/https) is required.",
        },
      };
    }

    return {
      invocationMessage: `Reading ${url}`,
      confirmationMessages: {
        title: "Z.AI Web Reader",
        message: new vscode.MarkdownString(`Fetch and extract content from \`${url}\` via Z.AI?`),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WebReadInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const client = await this.clientProvider();
      const url = options.input.url.trim();
      if (!this.isValidUrl(url)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Cannot read "${url}": not a valid http(s) URL. Ask the model for an absolute URL.`,
          ),
        ]);
      }

      const format = options.input.format ?? "markdown";
      const result = await client.webRead(url, format);
      return this.formatResult(result);
    } catch (error) {
      return this.formatError(error);
    }
  }

  /** Render extracted content with a small header block for context. */
  private formatResult(
    result: { url: string; title?: string; content: string },
  ): vscode.LanguageModelToolResult {
    const titleLine = result.title ? `Title: ${result.title}\n` : "";
    const header = `${titleLine}URL: ${result.url}\n\n`;

    const content =
      result.content.length > MAX_CONTENT_CHARS
        ? `${result.content.slice(0, MAX_CONTENT_CHARS)}\n\n…(truncated, ${result.content.length - MAX_CONTENT_CHARS} chars omitted)`
        : result.content;

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(header + content),
    ]);
  }

  private formatError(error: unknown): vscode.LanguageModelToolResult {
    let message: string;
    if (error instanceof MissingApiKeyError) {
      message =
        "Z.AI Web Reader failed: no API key configured. Ask the user to run " +
        "'Z.AI: Set API Key' from the command palette.";
    } else if (error instanceof ZaiApiError) {
      message = `Z.AI Web Reader failed (HTTP ${error.status}): ${error.message}`;
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      message = `Z.AI Web Reader failed: ${detail}`;
    }
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(message),
    ]);
  }

  private isValidUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
}
