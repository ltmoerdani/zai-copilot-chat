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

/** Error thrown when Z.AI chat API returns a non-recoverable HTTP status. */
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

// ---------------------------------------------------------------------------
// Phase 2 — Participant / orchestrator types
// ---------------------------------------------------------------------------

/** A fetched, ranked source ready for synthesis. */
export interface ResearchSource {
  url: string;
  title: string;
  /** Extracted main content (markdown). May be truncated for very long pages. */
  content: string;
  /** Relevance score in [0, 1] assigned by the ranker. */
  score: number;
  /** Where this source came from (which query surfaced it). */
  discoveredByQuery?: string;
}

/** A citation surfaced in the final synthesis. */
export interface Citation {
  index: number;
  url: string;
  title: string;
}

/** Phase emitted by the orchestrator for progress reporting. */
export type ResearchPhase =
  | { kind: "plan"; queries: string[] }
  | { kind: "search"; query: string; resultCount: number }
  | { kind: "read"; url: string; title?: string; ok: boolean }
  | { kind: "rank"; kept: number; dropped: number }
  | { kind: "synthesize"; chunks: number }
  | { kind: "done"; sources: number; citations: number };

/** Resolved configuration for a single research run. */
export interface ResearchConfig {
  maxSources: number;
  maxIterations: number;
  /** Parallel HTTP requests during the fetch phase. */
  concurrency: number;
  /** Cache TTL in seconds. 0 disables cache. */
  cacheTtlSeconds: number;
  /** Model id used for planning / synthesis LLM calls. */
  synthesisModel: string;
  /** Mode hint surfaced by the participant command. */
  mode: "quick" | "deep";
}

/** Result returned by the orchestrator at the end of a run. */
export interface ResearchResult {
  /** Final synthesis text (markdown). */
  synthesis: string;
  /** Ordered list of citations referenced in the synthesis. */
  citations: Citation[];
  /** All sources that survived ranking. */
  sources: ResearchSource[];
  /** Diagnostics for the output channel / telemetry. */
  stats: {
    queriesRun: number;
    urlsConsidered: number;
    sourcesRead: number;
    iterations: number;
    durationMs: number;
  };
}

