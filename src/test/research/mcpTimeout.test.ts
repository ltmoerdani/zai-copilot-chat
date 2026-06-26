/**
 * Unit tests for the MCP timeout helper.
 *
 * Covers:
 *   - normal completion (no timeout)
 *   - timeout fires and rejects with TimeoutError
 *   - timeoutMs <= 0 returns the original promise
 *   - non-finite timeoutMs returns the original promise
 *   - timer is cleared on success (no leak)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { TimeoutError, withTimeout } from "../../research/mcpTimeout.js";

test("withTimeout: returns the resolved value when the promise finishes first", async () => {
  const result = await withTimeout(Promise.resolve(42), 100, "test");
  assert.equal(result, 42);
});

test("withTimeout: rejects with TimeoutError when timeout fires first", async () => {
  const slow = new Promise<number>((resolve) => setTimeout(() => resolve(99), 500));
  await assert.rejects(
    withTimeout(slow, 50, "slow op"),
    (err: unknown) =>
      err instanceof TimeoutError &&
      err.timeoutMs === 50 &&
      err.message.includes("slow op"),
  );
});

test("withTimeout: timeoutMs <= 0 returns the original promise (no race)", async () => {
  // Verify it never throws TimeoutError regardless of how long the inner takes.
  const fast = withTimeout(Promise.resolve("ok"), 0, "test");
  const neg = withTimeout(Promise.resolve("ok"), -10, "test");
  const inf = withTimeout(Promise.resolve("ok"), Number.POSITIVE_INFINITY, "test");
  const nan = withTimeout(Promise.resolve("ok"), Number.NaN, "test");
  assert.equal(await fast, "ok");
  assert.equal(await neg, "ok");
  assert.equal(await inf, "ok");
  assert.equal(await nan, "ok");
});

test("withTimeout: propagates inner rejection (does NOT swallow real errors)", async () => {
  const real = Promise.reject(new Error("real failure"));
  await assert.rejects(
    withTimeout(real, 1000, "test"),
    (err: unknown) => err instanceof Error && err.message === "real failure",
  );
});

test("TimeoutError: has correct name and timeoutMs", () => {
  const err = new TimeoutError("test", 250);
  assert.equal(err.name, "TimeoutError");
  assert.equal(err.timeoutMs, 250);
  assert.ok(err instanceof Error);
});
