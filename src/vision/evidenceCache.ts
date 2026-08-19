/**
 * Pure in-memory evidence cache — no `vscode` import, unit-testable.
 *
 * Why this cache is non-negotiable: VS Code replays the ENTIRE conversation
 * history on every turn, so an image pasted three messages ago is re-delivered
 * as a DataPart on every follow-up. Without caching, each turn would re-run
 * modlens (5–45 s + vision-engine quota) for images already read.
 *
 * Key = sha256(image bytes) [+ ":" + sha256(prompt override)] — see
 * {@link evidenceCacheKey}. The persistent sidecar layer (globalStorage JSON
 * files) lives in visionBridge.ts; this class is only the memory tier.
 */

import { createHash } from "node:crypto";

export interface EvidenceCacheEntry {
  /** Fully formatted evidence block (the text injected into the message). */
  evidence: string;
  /** Winning engine label, e.g. `gemini-api/gemini-3.6-flash`. */
  provider?: string;
  cachedAt: number;
}

export interface EvidenceCacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface EvidenceCacheOptions {
  /** Max entries before the oldest is evicted. Default 32. */
  maxEntries?: number;
  /** Entry TTL in ms. `0` disables expiry. Default 0 (no TTL at memory tier). */
  ttlMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

export class EvidenceCache {
  private readonly entries = new Map<string, EvidenceCacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: EvidenceCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 32));
    this.ttlMs = Math.max(0, options.ttlMs ?? 0);
    this.now = options.now ?? Date.now;
  }

  get(key: string): EvidenceCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }

    // LRU touch: re-insert to move the key to the freshest position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: EvidenceCacheEntry): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, entry);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
      this.evictions++;
    }
  }

  /**
   * Stats-free presence check (does not count as hit/miss, does not LRU-touch).
   * Used by callers that only want to decide whether to announce work.
   */
  peek(key: string): EvidenceCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry)) {
      return undefined;
    }
    return entry;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): EvidenceCacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private isExpired(entry: EvidenceCacheEntry): boolean {
    if (this.ttlMs <= 0) {
      return false;
    }
    return this.now() - entry.cachedAt > this.ttlMs;
  }
}

/**
 * Compute the cache key for one image read.
 *
 * The key covers BOTH the image bytes and the optional `--prompt` override:
 * the same screenshot read with a different focus prompt is a different read.
 */
export function evidenceCacheKey(bytes: Uint8Array, promptOverride?: string): string {
  const imageHash = createHash("sha256").update(bytes).digest("hex");
  if (!promptOverride) {
    return imageHash;
  }
  const promptHash = createHash("sha256").update(promptOverride).digest("hex");
  return `${imageHash}:${promptHash}`;
}

/** File-name-safe cache key (strips the `:` separator for cross-platform paths). */
export function evidenceCacheFileName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}
