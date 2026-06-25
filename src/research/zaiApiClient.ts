/**
 * Thin HTTP client for Z.AI Web Search + Web Reader APIs.
 *
 * Reuses the same auth header, retry and timeout patterns as the chat provider
 * in `extension.ts` to keep behaviour consistent. All public methods return
 * typed results and throw {@link ZaiApiError} / {@link MissingApiKeyError} on
 * failure so callers can surface useful messages back to the language model.
 */

import * as vscode from "vscode";
import {
  MissingApiKeyError,
  ZaiApiError,
  type ZaiReadResult,
  type ZaiSearchResult,
} from "./types";

/** Base URL for the general Z.AI platform API. */
const ZAI_API_BASE = "https://api.z.ai/api/paas/v4";

/** Endpoint paths (kept as constants so they can be tuned in one place). */
const WEB_SEARCH_PATH = "/tools";
const WEB_READ_PATH = "/tools";

/** Time to wait between retry attempts (exponential backoff base, ms). */
const RETRY_BASE_DELAY_MS = 500;

/**
 * Lazily-resolved Z.AI API key. We read from SecretStorage on every call so
 * that key rotation / re-entry is picked up without re-activating the
 * extension.
 */
export type ApiKeyProvider = () => Promise<string | undefined>;

export interface ZaiApiClientOptions {
  apiKeyProvider: ApiKeyProvider;
  /** Per-request timeout in ms. Defaults to the chat provider default. */
  requestTimeoutMs?: number;
  /** Max retries on transient (5xx / network) errors. */
  maxRetries?: number;
  /** Output channel for diagnostic logs. */
  outputChannel?: vscode.OutputChannel;
}

export class ZaiApiClient {
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly outputChannel?: vscode.OutputChannel;

  constructor(private readonly options: ZaiApiClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.outputChannel = options.outputChannel;
  }

  /** Log a diagnostic line to the Z.AI output channel, if attached. */
  private log(message: string): void {
    this.outputChannel?.appendLine(`[${new Date().toISOString()}] [research] ${message}`);
  }

  /**
   * Search the web via Z.AI Web Search API.
   *
   * Returns up to `count` results (default 10, hard cap 50). Z.AI's search is
   * intent-optimised for LLM consumption — snippets are cleaner than raw
   * search-engine output.
   */
  async webSearch(query: string, count = 10): Promise<ZaiSearchResult[]> {
    const apiKey = await this.options.apiKeyProvider();
    if (!apiKey) throw new MissingApiKeyError();

    const cappedCount = Math.max(1, Math.min(count, 50));
    const body = {
      // Z.AI exposes web search via the tools endpoint with `request_id` named
      // tool identifier. The exact payload shape follows the public docs at
      // https://docs.z.ai/api-reference/tools/web-search
      request_id: "web-search-zai-copilot",
      query,
      count: cappedCount,
      search_intent: "research",
    };

    const json = await this.postJson(`${ZAI_API_BASE}${WEB_SEARCH_PATH}`, apiKey, body);
    return this.parseSearchResults(json);
  }

  /**
   * Read a single URL via Z.AI Web Reader API.
   *
   * Server-side Readability + anti-bot handling keeps the extension light and
   * avoids shipping a headless browser.
   */
  async webRead(url: string, format: "markdown" | "text" = "markdown"): Promise<ZaiReadResult> {
    const apiKey = await this.options.apiKeyProvider();
    if (!apiKey) throw new MissingApiKeyError();

    const body = {
      request_id: "web-reader-zai-copilot",
      url,
      format,
      cache: true,
    };

    const json = await this.postJson(`${ZAI_API_BASE}${WEB_READ_PATH}`, apiKey, body);
    return this.parseReadResult(json, url);
  }

  // ---- internals -----------------------------------------------------------

  /**
   * POST JSON to an endpoint with timeout, retries and structured error
   * handling. Mirrors the resilience behaviour of the chat completions path.
   */
  private async postJson(
    url: string,
    apiKey: string,
    body: unknown,
  ): Promise<unknown> {
    const payload = JSON.stringify(body);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        this.log(`POST ${url} (attempt ${attempt + 1}/${this.maxRetries + 1})`);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept-Language": "en-US,en",
          },
          body: payload,
          signal: controller.signal,
        });

        if (response.ok) {
          return await response.json();
        }

        // 401/403: do not retry — surface immediately.
        if (response.status === 401 || response.status === 403) {
          const text = await this.safeReadText(response);
          throw new ZaiApiError(
            `Authentication failed (${response.status}). Check your Z.AI API key. ${text}`,
            response.status,
            url,
          );
        }

        // 4xx (other than auth): do not retry.
        if (response.status >= 400 && response.status < 500) {
          const text = await this.safeReadText(response);
          throw new ZaiApiError(
            `Z.AI request rejected (${response.status}). ${text}`,
            response.status,
            url,
          );
        }

        // 5xx: retryable.
        const text = await this.safeReadText(response);
        lastError = new ZaiApiError(
          `Z.AI server error (${response.status}). ${text}`,
          response.status,
          url,
        );
      } catch (error) {
        if (error instanceof ZaiApiError && error.status < 500) {
          throw error;
        }
        // Network error or abort — retryable.
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.maxRetries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        this.log(`Retryable failure, waiting ${delay}ms before retry...`);
        await this.sleep(delay);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Z.AI request failed after retries");
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch {
      return "";
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Defensive parser for web search responses. Z.AI may wrap results under
   * different keys depending on API version, so we try several shapes.
   */
  private parseSearchResults(json: unknown): ZaiSearchResult[] {
    if (!json || typeof json !== "object") return [];

    const root = json as Record<string, unknown>;
    const candidates: unknown[] = [];

    // Common shapes: { results: [...] }, { data: [...] }, { output: [...] }
    for (const key of ["results", "data", "output", "items"]) {
      const value = root[key];
      if (Array.isArray(value)) {
        candidates.push(...value);
        break;
      }
    }

    // If the root itself is an array, use it directly.
    if (Array.isArray(json)) {
      candidates.push(...json);
    }

    return candidates
      .map((item): ZaiSearchResult | undefined => {
        if (!item || typeof item !== "object") return undefined;
        const obj = item as Record<string, unknown>;
        const url = typeof obj.url === "string" ? obj.url : typeof obj.link === "string" ? obj.link : undefined;
        const title = typeof obj.title === "string" ? obj.title : undefined;
        const snippet =
          typeof obj.snippet === "string"
            ? obj.snippet
            : typeof obj.content === "string"
              ? obj.content
              : typeof obj.summary === "string"
                ? obj.summary
                : "";
        if (!url || !title) return undefined;
        const source = typeof obj.source === "string" ? obj.source : undefined;
        return { title, url, snippet, source };
      })
      .filter((r): r is ZaiSearchResult => r !== undefined);
  }

  /** Defensive parser for web reader responses. */
  private parseReadResult(json: unknown, requestedUrl: string): ZaiReadResult {
    if (!json || typeof json !== "object") {
      return { url: requestedUrl, content: "" };
    }

    const root = json as Record<string, unknown>;
    const content =
      typeof root.content === "string"
        ? root.content
        : typeof root.markdown === "string"
          ? root.markdown
          : typeof root.text === "string"
            ? root.text
            : "";
    const title = typeof root.title === "string" ? root.title : undefined;
    const url = typeof root.url === "string" ? root.url : requestedUrl;

    return { url, title, content };
  }
}
