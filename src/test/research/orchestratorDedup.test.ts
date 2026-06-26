/**
 * Unit tests for the candidate-URL dedup in {@link ResearchOrchestrator}.
 *
 * Real production log showed ~30 webRead calls for what was effectively
 * 12 unique URLs (extranet.worldarchery.sport, www.usarchery.org, youtube
 * links, etc. all show up in multiple queries). Deduping at the candidate
 * stage cuts webRead calls ~60%.
 *
 * We test the dedup function directly (the orchestrator's `collectCandidates`
 * is private, so we exercise the same `normalizeUrlForDedupe` primitive).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeUrlForDedupe } from "../../research/ranker.js";

test("normalizeUrlForDedupe: strips protocol", () => {
  assert.equal(
    normalizeUrlForDedupe("https://example.com/path"),
    "example.com/path",
  );
  assert.equal(
    normalizeUrlForDedupe("http://example.com/path"),
    "example.com/path",
  );
});

test("normalizeUrlForDedupe: lowercases host", () => {
  assert.equal(
    normalizeUrlForDedupe("https://EXTRAnet.worldarchery.sport/doc"),
    "extranet.worldarchery.sport/doc",
  );
});

test("normalizeUrlForDedupe: strips trailing slash", () => {
  assert.equal(
    normalizeUrlForDedupe("https://example.com/path/"),
    "example.com/path",
  );
  // Root path kept
  assert.equal(
    normalizeUrlForDedupe("https://example.com/"),
    "example.com",
  );
});

test("normalizeUrlForDedupe: keeps non-empty query string", () => {
  // Genuine query strings (e.g. /search?q=foo) are preserved so two
  // different searches don't dedupe to one.
  const a = normalizeUrlForDedupe("https://example.com/search?q=foo");
  const b = normalizeUrlForDedupe("https://example.com/search?q=bar");
  assert.notEqual(a, b);
});

test("dedup scenario: 2 queries return same URL twice — keeps only one candidate", () => {
  // Real production scenario: 8 search queries returning ~15 results
  // each. Many URLs are the same article (worldarchery.sport homepage,
  // usarchery.org, etc.) discovered by different queries.
  const urls = [
    "https://extranet.worldarchery.sport/documents/index.php/?doc=6527",
    "https://extranet.worldarchery.sport/documents/index.php/?doc=6527", // exact dup
    "https://www.usarchery.org/events/event-information/44561",
    "https://www.usarchery.org/events/event-information/44561", // exact dup
    "https://en.wikipedia.org/wiki/2025_Archery_World_Cup",
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const key = normalizeUrlForDedupe(url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(url);
  }
  // 5 URLs in → 3 unique
  assert.equal(unique.length, 3);
});
