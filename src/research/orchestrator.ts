/**
 * Research orchestrator — the core loop of `@zai.research` (Phase 2, Part B).
 *
 * Responsibilities:
 *   1. Plan: ask the synthesis model for N diverse search queries from the
 *      user's topic.
 *   2. Search: run queries in parallel (bounded by `concurrency`), via
 *      {@link McpToolInvoker.webSearch} (Coding Plan MCP quota).
 *   3. Read: fetch full content of the most relevant URLs via
 *      {@link McpToolInvoker.webRead}, with two-tier caching.
 *   4. Rank: dedupe + score against the topic, keep top-K.
 *   5. Loop: if budget remains and coverage is thin, expand with follow-up
 *      queries derived from the gaps in what we have.
 *   6. Synthesize: map-reduce summarisation — chunk the sources, summarise each
 *      chunk, then ask the model for a final synthesis with inline citations.
 *
 * The orchestrator is I/O-only: it does not touch `vscode.window` or the chat
 * stream directly. The participant handler renders progress + final result.
 */

import * as vscode from "vscode";

import pLimit from "p-limit";

import { BudgetManager, estimateTokens } from "./budget";
import { Ranker } from "./ranker";
import { ResearchCache } from "./cache";
import { McpToolInvoker } from "./mcpTools";
import type {
  Citation,
  ResearchConfig,
  ResearchPhase,
  ResearchResult,
  ResearchSource,
} from "./types";

/** Default per-chunk size for map-reduce summarisation (in chars). */
const CHUNK_CHAR_TARGET = 8_000;

/** Max search results to request per query (API cap). */
const RESULTS_PER_QUERY = 15;

/**
 * Minimal LLM interface the orchestrator needs. The participant handler
 * supplies a concrete implementation backed by the Z.AI chat endpoint.
 */
export interface ResearchLLM {
  /**
   * Run a non-streaming completion. Returns the assistant text. Used for
   * planning (small prompts) and synthesis (potentially large prompts).
   */
  complete(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface OrchestratorDeps {
  /** MCP tool invoker for web search / read (Coding Plan quota). */
  mcpTools: McpToolInvoker;
  llm: ResearchLLM;
  cache: ResearchCache;
  config: ResearchConfig;
  topic: string;
  /** AbortSignal wired to the chat request cancellation token. */
  signal?: AbortSignal;
  /**
   * Optional `ChatParticipantToolToken` from the originating chat request.
   * Forwarded to MCP tool invocations so VS Code treats them as
   * user-authorised and skips the confirmation modal.
   */
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  /** Optional diagnostic logger (typically the Z.AI Research output channel). */
  log?: (message: string) => void;
}

export class ResearchOrchestrator {
  private readonly budget: BudgetManager;
  private readonly ranker: Ranker;
  private readonly queriesRun = new Set<string>();
  private urlsConsidered = 0;

  constructor(private readonly deps: OrchestratorDeps) {
    this.budget = new BudgetManager({
      // deep mode gets more tokens; quick mode stays lean.
      maxTokens: deps.config.mode === "deep" ? 600_000 : 120_000,
      maxIterations: deps.config.maxIterations,
      maxSources: deps.config.maxSources,
    });
    this.ranker = new Ranker(deps.config.mode === "deep" ? deps.topic : deps.topic, {
      maxKeep: deps.config.maxSources,
    });
  }

  /**
   * Run the full research loop, yielding progress phases as it goes. The
   * caller is expected to surface these to the user via the chat stream.
   */
  async *run(): AsyncGenerator<ResearchPhase, ResearchResult, unknown> {
    const startedAt = Date.now();
    const { mcpTools, llm, cache, config, topic, signal, toolInvocationToken } = this.deps;

    // --------------------------------------------------------------
    // Phase 1: plan
    // --------------------------------------------------------------
    const plan = await this.planQueries(llm, topic, signal);
    yield { kind: "plan", queries: plan };

    // --------------------------------------------------------------
    // Phase 2–5: iterate search → read → rank → maybe expand
    // --------------------------------------------------------------
    let activeQueries = plan;
    while (!this.budget.exhausted() && activeQueries.length > 0) {
      this.budget.consumeIteration();

      // parallelSearch is a generator that yields a "search" phase for
      // each query as it completes, giving the user real-time progress
      // (instead of one big batch update at the end).
      const searchGen = this.parallelSearch(activeQueries, toolInvocationToken);
      let searchHits: Map<string, Awaited<ReturnType<McpToolInvoker["webSearch"]>>> | undefined;
      while (true) {
        const step = await searchGen.next();
        if (step.done) {
          searchHits = step.value;
          break;
        }
        yield step.value;
      }

      const candidates = this.collectCandidates(activeQueries, searchHits!);
      if (candidates.length === 0) break;

      const { kept, dropped } = await this.readAndRank(
        candidates,
        mcpTools,
        cache,
        toolInvocationToken,
      );
      yield { kind: "rank", kept, dropped };

      // Plan the next expansion using the current top sources as context.
      if (this.budget.exhausted() || !this.budget.canFetchMore()) break;
      activeQueries = await this.expandQueries(llm, topic, signal);
    }

    // --------------------------------------------------------------
    // Phase 6: synthesise
    // --------------------------------------------------------------
    const sources = this.ranker.topK();
    yield { kind: "synthesize", chunks: Math.max(1, Math.ceil(this.totalChars(sources) / CHUNK_CHAR_TARGET)) };

    const { synthesis, citations } = await this.synthesize(llm, topic, sources, signal);

    const result: ResearchResult = {
      synthesis,
      citations,
      sources,
      stats: {
        queriesRun: this.queriesRun.size,
        urlsConsidered: this.urlsConsidered,
        sourcesRead: sources.length,
        iterations: this.budget.snapshot().iterationsUsed,
        durationMs: Date.now() - startedAt,
      },
    };

    yield { kind: "done", sources: result.sources.length, citations: result.citations.length };
    return result;
  }

  // ---- planning -----------------------------------------------------------

  private async planQueries(
    llm: ResearchLLM,
    topic: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const system =
      "You are a research planner. Given a topic, produce a JSON array of 5-10 diverse web search queries that together would give comprehensive coverage. Vary phrasings, include recent-year qualifiers, and cover sub-topics. Return ONLY the JSON array, no prose.";
    const user = `Topic: ${topic}\n\nReturn a JSON array of search query strings.`;
    const raw = await llm.complete(system, user, signal);
    return this.parseQueryList(raw, 10);
  }

  private async expandQueries(
    llm: ResearchLLM,
    topic: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const seen = Array.from(this.queriesRun).slice(-15).map((q) => `- ${q}`).join("\n");
    const system =
      "You are a research planner expanding coverage. Produce a JSON array of 3-5 NEW web search queries that explore facets of the topic NOT already covered by the queries already run. Return ONLY the JSON array.";
    const user = `Topic: ${topic}\n\nAlready-run queries:\n${seen}\n\nReturn a JSON array of NEW search query strings.`;
    const raw = await llm.complete(system, user, signal);
    return this.parseQueryList(raw, 5);
  }

  /** Parse a JSON-ish LLM response into a list of queries. Defensive. */
  private parseQueryList(raw: string, cap: number): string[] {
    try {
      // Strip code fences if the model wrapped the JSON in ```json ... ```.
      const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed
          .map((q) => (typeof q === "string" ? q.trim() : ""))
          .filter((q) => q.length > 0)
          .slice(0, cap);
      }
    } catch {
      // fall through to line-based fallback
    }
    // Fallback: split by newlines / quotes.
    return raw
      .split(/\n|"\s*,\s*"/)
      .map((s) => s.replace(/["\]\[]/g, "").trim())
      .filter((s) => s.length > 4)
      .slice(0, cap);
  }

  // ---- search & read ------------------------------------------------------

  /**
   * Run queries in parallel, bounded by `concurrency`. Yields a
   * `search` phase for each query as it completes (giving the user
   * real-time progress), then returns the final `query → results` map.
   *
   * Failures are swallowed (logged) so one bad query does not abort the
   * run. A query that times out via `McpToolInvoker.webSearch` returns
   * an empty result list and the phase is yielded with `resultCount: 0`.
   */
  private async *parallelSearch(
    queries: string[],
    token?: vscode.ChatParticipantToolToken,
  ): AsyncGenerator<
    ResearchPhase,
    Map<string, Awaited<ReturnType<McpToolInvoker["webSearch"]>>>,
    unknown
  > {
    const { mcpTools, cache, config } = this.deps;
    const limit = pLimit(config.concurrency);
    const out = new Map<string, Awaited<ReturnType<McpToolInvoker["webSearch"]>>>();

    // Event-based completion queue. Each task pushes a {query, results}
    // entry when done and calls `notify()` to wake the generator loop.
    // The loop drains the queue one item at a time and yields a phase.
    interface DoneEvent {
      query: string;
      results: Awaited<ReturnType<McpToolInvoker["webSearch"]>>;
    }
    const doneQueue: DoneEvent[] = [];
    let resolveWait: (() => void) | null = null;
    const notify = (): void => {
      const r = resolveWait;
      resolveWait = null;
      if (r) r();
    };

    const tasks = queries.map((q) =>
      limit(async () => {
        this.queriesRun.add(q);
        const cacheKey = `${q}|${RESULTS_PER_QUERY}`;
        try {
          const cached = cache.enabled
            ? ((await cache.getSearch(cacheKey)) as
                | Awaited<ReturnType<McpToolInvoker["webSearch"]>>
                | undefined)
            : undefined;
          if (cached) {
            doneQueue.push({ query: q, results: cached });
            notify();
            return;
          }
          const results = await mcpTools.webSearch(q, RESULTS_PER_QUERY, token, 2);
          if (cache.enabled) await cache.setSearch(cacheKey, results);
          doneQueue.push({ query: q, results });
          notify();
        } catch (error) {
          // Log and swallow — one failing query should not abort the run,
          // but silent failures make debugging impossible.
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.log?.(`webSearch failed for "${q}": ${detail}`);
          doneQueue.push({ query: q, results: [] });
          notify();
        }
      }),
    );

    // Drain the queue, yielding per-query progress. If a task is still
    // in flight when we get here, wait on the resolver.
    for (let i = 0; i < tasks.length; i++) {
      if (doneQueue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
      const event = doneQueue.shift()!;
      out.set(event.query, event.results);
      yield { kind: "search", query: event.query, resultCount: event.results.length };
    }

    return out;
  }

  /** Flatten search hits into candidate URLs with the originating query. */
  private collectCandidates(
    queries: string[],
    hits: Map<string, { url: string; title: string; snippet: string }[]>,
  ): Array<{ url: string; title: string; snippet: string; query: string }> {
    const out: Array<{ url: string; title: string; snippet: string; query: string }> = [];
    for (const q of queries) {
      const list = hits.get(q) ?? [];
      for (const r of list) {
        this.urlsConsidered++;
        out.push({ url: r.url, title: r.title, snippet: r.snippet, query: q });
      }
    }
    return out;
  }

  /**
   * Read & score each candidate. Dedupes and keeps the best variant via the
   * {@link Ranker}. Returns counts for progress reporting.
   */
  private async readAndRank(
    candidates: Array<{ url: string; title: string; snippet: string; query: string }>,
    mcpTools: McpToolInvoker,
    cache: ResearchCache,
    token?: vscode.ChatParticipantToolToken,
  ): Promise<{ kept: number; dropped: number }> {
    const limit = pLimit(this.deps.config.concurrency);
    const before = this.ranker.size;

    await Promise.all(
      candidates.map((c) =>
        limit(async () => {
          if (!this.budget.canFetchMore()) return;

          // Pre-score the snippet first; skip reads for obvious junk so we
          // don't burn budget on low-relevance URLs.
          const snippetScore = this.ranker.scoreCandidate({
            title: c.title,
            snippet: c.snippet,
          });
          if (snippetScore === 0 && this.budget.snapshot().sourcesFetched > 5) {
            // Low signal — skip the read unless we're still warming up.
            return;
          }

          try {
            const cachedContent = cache.enabled ? await cache.getRead(c.url) : undefined;
            let content = cachedContent;
            if (!content) {
              const read = await mcpTools.webRead(c.url, "markdown", token);
              content = read.content;
              if (cache.enabled) await cache.setRead(c.url, content);
            }
            if (!content) return;

            this.budget.consumeSource();
            this.budget.consumeTokens(estimateTokens(content));

            const score = Math.max(
              snippetScore,
              this.ranker.scoreCandidate({ title: c.title, snippet: c.snippet, content }),
            );
            const source: ResearchSource = {
              url: c.url,
              title: c.title,
              content,
              score,
              discoveredByQuery: c.query,
            };
            this.ranker.add([source]);
          } catch {
            // Individual read failure — skip.
          }
        }),
      ),
    );

    const after = this.ranker.size;
    return { kept: Math.max(0, after - before), dropped: candidates.length - Math.max(0, after - before) };
  }

  // ---- synthesis ----------------------------------------------------------

  /**
   * Map-reduce synthesis: chunk all sources, summarise each chunk via the LLM,
   * then ask for a final synthesis that cites sources inline as `[n]`.
   */
  private async synthesize(
    llm: ResearchLLM,
    topic: string,
    sources: ResearchSource[],
    signal?: AbortSignal,
  ): Promise<{ synthesis: string; citations: Citation[] }> {
    if (sources.length === 0) {
      return {
        synthesis: `_No usable sources were found for "${topic}". Try rephrasing the topic or use \`@zai.research /quick\` for a faster pass._`,
        citations: [],
      };
    }

    // Build citation table: [1] title url
    const citations: Citation[] = sources.map((s, i) => ({
      index: i + 1,
      url: s.url,
      title: s.title,
    }));

    // Map: per-chunk summaries.
    const chunks = this.chunkSources(sources);
    const chunkSummaries = await Promise.all(
      chunks.map((chunk, i) =>
        this.summarizeChunk(llm, topic, chunk, i + 1, chunks.length, signal).catch(
          () => "(chunk summary unavailable)",
        ),
      ),
    );

    // Reduce: final synthesis from the chunk summaries + citation table.
    const citationTable = citations
      .map((c) => `[${c.index}] ${c.title} — ${c.url}`)
      .join("\n");

    const reduceSystem =
      "You are a research synthesizer. Using the provided chunk summaries and citation table, write a comprehensive, well-structured markdown report on the topic. Cite sources inline using [n] notation matching the citation table. Be concrete and factual; do not invent facts. End with a '## Sources' section listing the citations.";
    const reduceUser =
      `Topic: ${topic}\n\n` +
      `Chunk summaries:\n${chunkSummaries.map((s, i) => `### Chunk ${i + 1}\n${s}`).join("\n\n")}\n\n` +
      `Citation table:\n${citationTable}\n\n` +
      `Write the final synthesis now.`;

    const synthesis = await llm.complete(reduceSystem, reduceUser, signal);
    this.budget.consumeTokens(estimateTokens(synthesis));

    return { synthesis, citations };
  }

  private async summarizeChunk(
    llm: ResearchLLM,
    topic: string,
    chunk: Array<{ index: number; content: string }>,
    chunkIndex: number,
    totalChunks: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const system =
      "You are a precise summarizer. Summarize the provided source excerpts in the context of the research topic. Preserve concrete facts, numbers, and names. Keep citations [n] from the source. Output plain markdown prose, no preamble.";
    const tagged = chunk
      .map((s) => `--- SOURCE [${s.index}] ---\n${this.truncate(s.content, CHUNK_CHAR_TARGET / chunk.length)}\n`)
      .join("\n");
    const user =
      `Topic: ${topic}\n\n` +
      `Summarize the following sources (chunk ${chunkIndex}/${totalChunks}):\n\n${tagged}`;

    return llm.complete(system, user, signal);
  }

  /** Split sources into chunks small enough for one LLM call each. */
  private chunkSources(sources: ResearchSource[]): Array<{ index: number; content: string }[]> {
    const chunks: Array<{ index: number; content: string }[]> = [];
    let current: Array<{ index: number; content: string }> = [];
    let currentChars = 0;
    const indexed = sources.map((s, i) => ({ index: i + 1, content: s.content }));

    for (const s of indexed) {
      if (currentChars + s.content.length > CHUNK_CHAR_TARGET && current.length > 0) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(s);
      currentChars += s.content.length;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  // ---- helpers ------------------------------------------------------------

  private totalChars(sources: ResearchSource[]): number {
    return sources.reduce((sum, s) => sum + s.content.length, 0);
  }

  private truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max))}…`;
  }

}
