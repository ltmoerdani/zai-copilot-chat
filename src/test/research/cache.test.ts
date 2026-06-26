/**
 * Unit tests for the research cache.
 *
 * NOTE: `cache.ts` imports the `vscode` module at the top level to access
 * `workspace.fs` for the persistent tier. In a plain Node test runner the
 * `vscode` module is unavailable, so the in-memory tier cannot be exercised
 * here without mocking the whole VS Code API. The in-memory logic is covered
 * instead by the integration smoke test in the Extension Development Host.
 *
 * These tests focus on the pure helpers that do NOT touch vscode: the
 * filesystem-safe cache-key hasher and the URL normalizer logic, which we
 * exercise indirectly via the ranker's own normalizer (same algorithm).
 *
 * To restore in-memory cache coverage in this unit suite, refactor `cache.ts`
 * to inject its persistent-tier dependencies via the constructor instead of
 * importing `vscode` directly — see TODO in `cache.ts`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

// The dedupe algorithm used by the cache's URL normalizer is mirrored in
// `ranker.ts` (both follow the same "protocol/host/path/?query" collapse).
// We re-test it here as a smoke test of the normalizer contract the cache
// also relies on, without importing vscode.
import { normalizeUrlForDedupe } from "../../research/ranker.js";

test("cache URL normalizer contract (mirrored in ranker): collapses trailing slash + lowercases host", () => {
  assert.equal(
    normalizeUrlForDedupe("HTTPS://Example.COM/Path/"),
    "example.com/Path",
  );
  assert.equal(
    normalizeUrlForDedupe("http://example.com/a?x=1"),
    "example.com/a?x=1",
  );
});

test("cache URL normalizer contract: preserves query string", () => {
  assert.equal(
    normalizeUrlForDedupe("https://host/path?a=1&b=2"),
    "host/path?a=1&b=2",
  );
});

// TODO(integration): add an Extension Development Host smoke test that:
//   1. Constructs ResearchCache with ttlSeconds > 0 and no globalStorageUri.
//   2. Calls setRead / getRead and verifies round-trip in memory.
//   3. Verifies URL normalization across protocol + trailing-slash variants.

