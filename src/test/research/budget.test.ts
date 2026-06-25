/**
 * Unit tests for the budget manager.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { BudgetManager, estimateTokens } from "../../research/budget.js";

test("estimateTokens: handles empty, latin, and CJK text", () => {
  assert.equal(estimateTokens(""), 0);
  // Latin text ≈ 1 token per 4 chars.
  assert.equal(estimateTokens("hello world"), Math.ceil("hello world".length / 4));
  // CJK counts 1:1.
  assert.equal(estimateTokens("你好世界"), 4);
  // Mixed: 2 CJK + 9 latin (incl. leading space) → 2 + ceil(9/4) = 2 + 3 = 5
  assert.equal(estimateTokens("你好 abcd1234"), 5);
});

test("BudgetManager: starts non-exhausted", () => {
  const b = new BudgetManager({
    maxTokens: 1000,
    maxIterations: 5,
    maxSources: 10,
  });
  assert.equal(b.exhausted(), false);
  assert.equal(b.canFetchMore(), true);
});

test("BudgetManager.exhausted: hits token cap", () => {
  const b = new BudgetManager({
    maxTokens: 100,
    maxIterations: 5,
    maxSources: 10,
  });
  b.consumeTokens(100);
  assert.equal(b.exhausted(), true);
  assert.equal(b.canFetchMore(), false);
});

test("BudgetManager.exhausted: hits iteration cap", () => {
  const b = new BudgetManager({
    maxTokens: 1000,
    maxIterations: 2,
    maxSources: 10,
  });
  b.consumeIteration();
  assert.equal(b.exhausted(), false);
  b.consumeIteration();
  assert.equal(b.exhausted(), true);
});

test("BudgetManager.exhausted: hits source cap", () => {
  const b = new BudgetManager({
    maxTokens: 1000,
    maxIterations: 5,
    maxSources: 1,
  });
  assert.equal(b.canFetchMore(), true);
  b.consumeSource();
  assert.equal(b.exhausted(), true);
  assert.equal(b.canFetchMore(), false);
});

test("BudgetManager.snapshot: reflects current consumption", () => {
  const b = new BudgetManager({
    maxTokens: 1000,
    maxIterations: 5,
    maxSources: 10,
  });
  b.consumeTokens(250);
  b.consumeIteration();
  b.consumeSource();
  b.consumeSource();

  const snap = b.snapshot();
  assert.equal(snap.tokensUsed, 250);
  assert.equal(snap.iterationsUsed, 1);
  assert.equal(snap.sourcesFetched, 2);
});

test("BudgetManager.consumeTokens: ignores negative input", () => {
  const b = new BudgetManager({
    maxTokens: 100,
    maxIterations: 5,
    maxSources: 10,
  });
  b.consumeTokens(-50);
  assert.equal(b.snapshot().tokensUsed, 0);
});
