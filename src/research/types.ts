/**
 * Shared types for the Z.AI research feature (Part A — Language Model Tools).
 *
 * These interfaces describe inputs/outputs of the Z.AI Web Search and Web
 * Reader APIs and the Language Model Tools that wrap them.
 */

/** A single result returned by Z.AI Web Search API. */
export interface ZaiSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Optional intent / source metadata (may or may not be present). */
  source?: string;
}

/** Input for the `zai_webSearch` language model tool. */
export interface WebSearchInput {
  query: string;
  /** Number of results to request. Defaults to 10, capped at 50. */
  count?: number;
}

/** Result returned by Z.AI Web Reader API. */
export interface ZaiReadResult {
  url: string;
  title?: string;
  content: string;
}

/** Input for the `zai_webRead` language model tool. */
export interface WebReadInput {
  url: string;
  /** Output format. Defaults to "markdown". */
  format?: "markdown" | "text";
}

/** Error thrown when the Z.AI API key is missing or invalid. */
export class MissingApiKeyError extends Error {
  constructor(message = "Z.AI API key not configured. Use 'Z.AI: Set API Key' first.") {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

/** Error thrown when Z.AI tools API returns a non-recoverable HTTP status. */
export class ZaiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "ZaiApiError";
  }
}
