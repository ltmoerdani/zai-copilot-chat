/**
 * Two-tier cache for Z.AI Web Search + Web Reader responses.
 *
 * - In-memory `Map` for hot lookups (instant, no I/O).
 * - Optional persistent tier in `context.globalStorageUri` for cross-session
 *   reuse. Disabled when TTL is 0.
 *
 * Keys are normalized URLs (for reads) or `query|count` tuples (for searches).
 * The cache never throws — a miss returns `undefined` and a write failure is
 * logged and swallowed.
 */

import * as vscode from "vscode";

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms
}

/** Default in-memory cap to avoid unbounded growth during a long deep-research run. */
const MAX_IN_MEMORY_ENTRIES = 500;

export class ResearchCache {
  private readonly memory = new Map<string, CacheEntry<unknown>>();
  private readonly persistentDir?: vscode.Uri;
  private readonly ttlMs: number;

  constructor(options: {
    /** TTL in seconds. 0 disables the cache entirely. */
    ttlSeconds: number;
    /** Global storage URI for the persistent tier, if enabled. */
    globalStorageUri?: vscode.Uri;
  }) {
    this.ttlMs = options.ttlSeconds * 1000;
    if (options.ttlSeconds > 0 && options.globalStorageUri) {
      this.persistentDir = vscode.Uri.joinPath(
        options.globalStorageUri,
        "zai-research-cache",
      );
    }
  }

  /** Whether caching is enabled at all. */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /** Read a cached web-reader result for a URL. */
  async getRead(url: string): Promise<string | undefined> {
    return this.get<string>(`read:${this.normalizeUrl(url)}`);
  }

  /** Store a web-reader result. */
  async setRead(url: string, content: string): Promise<void> {
    await this.set(`read:${this.normalizeUrl(url)}`, content);
  }

  /** Read a cached search result list for a query+count key. */
  async getSearch(key: string): Promise<unknown[] | undefined> {
    return this.get<unknown[]>(`search:${key}`);
  }

  /** Store search results. */
  async setSearch(key: string, results: unknown[]): Promise<void> {
    await this.set(`search:${key}`, results);
  }

  /** Drop everything. Called at the start of a fresh "force refresh" run. */
  clear(): void {
    this.memory.clear();
  }

  // ---- internals -----------------------------------------------------------

  /** Inline URL normalizer (avoid ESM-only `normalize-url` dependency). */
  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/+$/, "");
      return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
    } catch {
      return url;
    }
  }

  private async get<T>(key: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;

    const now = Date.now();
    const mem = this.memory.get(key) as CacheEntry<T> | undefined;
    if (mem) {
      if (mem.expiresAt > now) return mem.value;
      this.memory.delete(key);
    }

    const persisted = await this.readPersistent<T>(key);
    if (persisted && persisted.expiresAt > now) {
      // Promote back into memory.
      this.memory.set(key, persisted as CacheEntry<unknown>);
      return persisted.value;
    }
    return undefined;
  }

  private async set<T>(key: string, value: T): Promise<void> {
    if (!this.enabled) return;

    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + this.ttlMs,
    };

    // Bound in-memory growth by evicting oldest entries.
    if (this.memory.size >= MAX_IN_MEMORY_ENTRIES) {
      const firstKey = this.memory.keys().next().value;
      if (firstKey) this.memory.delete(firstKey);
    }
    this.memory.set(key, entry as unknown as CacheEntry<unknown>);

    await this.writePersistent(key, entry);
  }

  private async readPersistent<T>(key: string): Promise<CacheEntry<T> | undefined> {
    if (!this.persistentDir) return undefined;
    try {
      const uri = vscode.Uri.joinPath(this.persistentDir, `${this.safeName(key)}.json`);
      const buf = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as CacheEntry<T>;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async writePersistent<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    if (!this.persistentDir) return;
    try {
      await vscode.workspace.fs.createDirectory(this.persistentDir);
      const uri = vscode.Uri.joinPath(this.persistentDir, `${this.safeName(key)}.json`);
      const buf = Buffer.from(JSON.stringify(entry), "utf8");
      await vscode.workspace.fs.writeFile(uri, new Uint8Array(buf));
    } catch {
      // Best-effort; a write failure must not break the research run.
    }
  }

  /** Map arbitrary cache key to a filesystem-safe filename. */
  private safeName(key: string): string {
    // Keep it short to avoid OS path limits; sha-like hash via simple djb2.
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }
}
