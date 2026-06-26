/**
 * Ranker & deduper for research sources.
 *
 * The ranker accumulates {@link ResearchSource} entries across iterations and
 * answers two questions for the orchestrator:
 *
 * 1. **Dedupe** — same URL discovered by different queries collapses to one.
 * 2. **Top-K by relevance** — a lightweight score combining keyword overlap
 *    (BM25-style term frequency) and a small freshness/recency boost.
 *
 * Embeddings would give better semantic ranking, but they require an extra API
 * round-trip per source and are deferred to Phase 3. The BM25-style score is
 * good enough to keep the top-K signal-rich while staying free and offline.
 */

import type { ResearchSource } from "./types";

/** Normalize a URL for dedupe: strip protocol, trailing slash, lowercase host. */
export function normalizeUrlForDedupe(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    const query = u.search ? u.search : "";
    return `${u.host.toLowerCase()}${path}${query}`;
  } catch {
    return url.toLowerCase();
  }
}

/** Tokenize text into lowercase terms for term-frequency scoring. */
function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Keep words, digits, and CJK runs. \p{L} and \p{N} cover unicode.
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export interface RankerOptions {
  /** Maximum number of sources the ranker should keep. */
  maxKeep: number;
}

export class Ranker {
  /** Dedupe map: normalized URL → ResearchSource */
  private readonly byUrl = new Map<string, ResearchSource>();
  /** Term frequency index of the user's topic, for scoring. */
  private readonly topicTerms: Map<string, number>;
  private readonly maxKeep: number;

  constructor(topic: string, options: RankerOptions) {
    this.maxKeep = options.maxKeep;
    this.topicTerms = this.buildTermFrequency(topic);
  }

  /**
   * Add a batch of sources. Duplicates (by URL) are merged — the highest-scored
   * variant wins, and the `discoveredByQuery` of the first sighting is kept.
   */
  add(sources: ResearchSource[]): { added: number; duplicates: number } {
    let added = 0;
    let duplicates = 0;

    for (const src of sources) {
      const key = normalizeUrlForDedupe(src.url);
      const existing = this.byUrl.get(key);
      if (existing) {
        duplicates++;
        // Keep the better-scoring copy.
        if (src.score > existing.score) {
          this.byUrl.set(key, {
            ...src,
            discoveredByQuery: existing.discoveredByQuery ?? src.discoveredByQuery,
          });
        }
        continue;
      }
      this.byUrl.set(key, src);
      added++;
    }
    return { added, duplicates };
  }

  /** Number of unique sources collected so far. */
  get size(): number {
    return this.byUrl.size;
  }

  /** Return the top-K sources by score, descending. */
  topK(): ResearchSource[] {
    return Array.from(this.byUrl.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxKeep);
  }

  /**
   * Score a candidate source against the topic. Combines:
   * - term-frequency overlap with the topic (BM25-ish)
   * - light freshness boost for sources with a 4-digit year in title/snippet
   */
  scoreCandidate(input: { title: string; snippet: string; content?: string }): number {
    const haystack = `${input.title} ${input.snippet} ${input.content ?? ""}`;
    const terms = tokenize(haystack);
    if (terms.length === 0) return 0;

    const termSet = new Set(terms);
    let overlap = 0;
    for (const term of termSet) {
      if (this.topicTerms.has(term)) overlap++;
    }
    const overlapScore = this.topicTerms.size > 0 ? overlap / this.topicTerms.size : 0;

    // Recency boost: +0.1 if a plausible recent year appears.
    const currentYear = new Date().getFullYear();
    const recentYears = [currentYear, currentYear - 1, currentYear - 2].map(String);
    const recencyBoost = recentYears.some((y) => haystack.includes(y)) ? 0.1 : 0;

    return Math.min(1, overlapScore + recencyBoost);
  }

  /** Build a term-frequency index from the topic string, down-weighting stopwords. */
  private buildTermFrequency(topic: string): Map<string, number> {
    const STOPWORDS = new Set([
      "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
      "about", "into", "is", "are", "be", "as", "at", "by", "that", "this",
      "it", "from", "how", "what", "when", "where", "which", "why", "will",
      "dan", "dari", "untuk", "pada", "dengan", "tentang", "yang", "ke", "di",
      "atau", "adalah", "ini", "itu", "saya", "anda", "kita", "mereka",
    ]);

    const terms = tokenize(topic);
    const tf = new Map<string, number>();
    for (const term of terms) {
      if (STOPWORDS.has(term) || term.length < 2) continue;
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    return tf;
  }
}
