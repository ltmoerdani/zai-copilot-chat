/**
 * Unit tests for the MCP input builders.
 *
 * These builders encapsulate the field names the Z.AI MCP server expects.
 * A previous version used `query` instead of `search_query`, which caused
 * the server to return `-400: search_query cannot be empty`. Locking the
 * field names down with tests prevents regressions.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildWebReadInput,
  buildWebSearchInput,
} from "../../research/mcpInputBuilders.js";

test("buildWebSearchInput: uses `search_query` field, not `query`", () => {
  const input = buildWebSearchInput("test query", 10);
  assert.equal(input.search_query, "test query");
  assert.equal(input.count, 10);
  // The server rejects with -400 if `query` is sent; assert it is absent.
  assert.equal("query" in input, false);
});

test("buildWebSearchInput: preserves unicode queries", () => {
  const input = buildWebSearchInput("pendaftaran tim beregu panahan", 15);
  assert.equal(input.search_query, "pendaftaran tim beregu panahan");
  assert.equal(input.count, 15);
});

test("buildWebSearchInput: handles empty string (server will reject)", () => {
  // The builder is dumb — it should not silently rewrite. The server's
  // -400 response is the source of truth for emptiness.
  const input = buildWebSearchInput("", 10);
  assert.equal(input.search_query, "");
  assert.equal(input.count, 10);
});

test("buildWebReadInput: uses `url` and `return_format`", () => {
  const input = buildWebReadInput("https://example.com", "markdown");
  assert.equal(input.url, "https://example.com");
  assert.equal(input.return_format, "markdown");
});

test("buildWebReadInput: text format", () => {
  const input = buildWebReadInput("https://example.com", "text");
  assert.equal(input.return_format, "text");
});
