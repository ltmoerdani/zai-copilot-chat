/**
 * Unit tests for the in-memory evidence cache and cache-key derivation.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EvidenceCache,
  evidenceCacheFileName,
  evidenceCacheKey,
} from "../../vision/evidenceCache.js";

function entry(cachedAt: number, evidence = "ev"): { evidence: string; cachedAt: number } {
  return { evidence, cachedAt };
}

test("evidenceCacheKey: deterministic for identical bytes", () => {
  const a = evidenceCacheKey(new Uint8Array([1, 2, 3]));
  const b = evidenceCacheKey(new Uint8Array([1, 2, 3]));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("evidenceCacheKey: differs for different bytes", () => {
  assert.notEqual(evidenceCacheKey(new Uint8Array([1, 2, 3])), evidenceCacheKey(new Uint8Array([3, 2, 1])));
});

test("evidenceCacheKey: prompt override changes the key", () => {
  const bytes = new Uint8Array([9, 9]);
  const plain = evidenceCacheKey(bytes);
  const focused = evidenceCacheKey(bytes, "focus on axes");
  const focusedAgain = evidenceCacheKey(bytes, "focus on axes");
  assert.notEqual(plain, focused);
  assert.equal(focused, focusedAgain);
  assert.match(focused, /^[0-9a-f]{64}:[0-9a-f]{64}$/);
});

test("evidenceCacheFileName: strips path-unsafe separators", () => {
  assert.equal(evidenceCacheFileName("abc:def"), "abc_def");
  assert.equal(evidenceCacheFileName("abc"), "abc");
});

test("EvidenceCache: set then get is a hit; unknown key is a miss", () => {
  const cache = new EvidenceCache();
  cache.set("k", entry(1000));
  assert.equal(cache.get("k")?.evidence, "ev");
  assert.equal(cache.get("nope"), undefined);

  const stats = cache.stats();
  assert.equal(stats.size, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test("EvidenceCache: TTL expiry turns a hit into a miss and drops the entry", () => {
  let now = 1000;
  const cache = new EvidenceCache({ ttlMs: 5000, now: () => now });
  cache.set("k", entry(now));
  assert.ok(cache.get("k")); // fresh

  now += 5001; // past TTL
  assert.equal(cache.get("k"), undefined);
  assert.equal(cache.stats().size, 0);
});

test("EvidenceCache: ttlMs 0 disables expiry", () => {
  let now = 0;
  const cache = new EvidenceCache({ ttlMs: 0, now: () => now });
  cache.set("k", entry(0));
  now += 10_000_000;
  assert.ok(cache.get("k"));
});

test("EvidenceCache: evicts oldest entries beyond maxEntries", () => {
  const cache = new EvidenceCache({ maxEntries: 2 });
  cache.set("a", entry(1, "A"));
  cache.set("b", entry(2, "B"));
  cache.set("c", entry(3, "C")); // evicts "a"

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b")?.evidence, "B");
  assert.equal(cache.get("c")?.evidence, "C");
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.stats().size, 2);
});

test("EvidenceCache: get() refreshes LRU position (oldest is evicted, not most-recently-read)", () => {
  const cache = new EvidenceCache({ maxEntries: 2 });
  cache.set("a", entry(1, "A"));
  cache.set("b", entry(2, "B"));
  assert.ok(cache.get("a")); // touch "a" → "b" becomes oldest
  cache.set("c", entry(3, "C")); // evicts "b"

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a")?.evidence, "A");
});

test("EvidenceCache: peek does not touch stats or LRU order", () => {
  const cache = new EvidenceCache({ maxEntries: 2 });
  cache.set("a", entry(1, "A"));
  assert.ok(cache.peek("a"));
  assert.equal(cache.peek("missing"), undefined);

  const stats = cache.stats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);

  // peek("a") must NOT have refreshed it: with "b" inserted after, "a" stays
  // oldest and gets evicted next.
  cache.set("b", entry(2, "B"));
  cache.set("c", entry(3, "C"));
  assert.equal(cache.get("a"), undefined);
});

test("EvidenceCache: peek respects TTL", () => {
  let now = 0;
  const cache = new EvidenceCache({ ttlMs: 100, now: () => now });
  cache.set("k", entry(0));
  now = 101;
  assert.equal(cache.peek("k"), undefined);
});

test("EvidenceCache: clear empties everything", () => {
  const cache = new EvidenceCache();
  cache.set("a", entry(1));
  cache.clear();
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.get("a"), undefined);
});
