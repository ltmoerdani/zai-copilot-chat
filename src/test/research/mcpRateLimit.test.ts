/**
 * Unit tests for the rate-limit detector and retry helpers.
 *
 * The Z.AI MCP server returns strings like:
 *   `MCP error -429: {"error":{"code":"1302","message":"Rate limit reached for requests"}}`
 * We detect these so {@link McpToolInvoker.webSearch} can retry with
 * exponential backoff instead of swallowing the error.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isRateLimitError, RateLimitError } from "../../research/mcpRateLimit.js";

test("isRateLimitError: detects MCP error -429 format", () => {
  const text = `MCP error -429: {"error":{"code":"1302","message":"Rate limit reached for requests"}}`;
  assert.equal(isRateLimitError(text), true);
});

test("isRateLimitError: detects 'Rate limit' substring", () => {
  assert.equal(isRateLimitError("Rate limit reached for requests"), true);
  assert.equal(isRateLimitError("Hit a rate limit, please retry"), true);
});

test("isRateLimitError: ignores normal result text", () => {
  assert.equal(isRateLimitError(`[{"title":"A","link":"u","content":"x"}]`), false);
  assert.equal(isRateLimitError(`{"search_result": [...]}`), false);
  assert.equal(isRateLimitError(""), false);
});

test("isRateLimitError: skips giant bodies to avoid false positives", () => {
  const huge = "Rate limit " + "x".repeat(5_000);
  assert.equal(isRateLimitError(huge), false);
});

test("isRateLimitError: handles non-string input safely", () => {
  assert.equal(isRateLimitError(undefined as unknown as string), false);
  assert.equal(isRateLimitError(null as unknown as string), false);
  assert.equal(isRateLimitError(42 as unknown as string), false);
});

test("RateLimitError: preserves payload for diagnostics", () => {
  const payload = `MCP error -429: {"error":{"code":"1302","message":"Rate limit reached"}}`;
  const err = new RateLimitError("test", payload);
  assert.equal(err.name, "RateLimitError");
  assert.equal(err.payload, payload);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof RateLimitError);
});
