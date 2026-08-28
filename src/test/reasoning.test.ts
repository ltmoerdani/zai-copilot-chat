/**
 * Unit tests for reasoning-effort resolution.
 *
 * CONTRACT: `reasoning.ts` is pure (no `vscode` import), so these run under
 * plain `node:test` like the other pure-module suites.
 *
 * Evidence anchors for each mapping: see the header of `src/reasoning.ts`
 * (docs.z.ai concept-param + glm-5.3 pages, retrieved 2026-08-19).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  REASONING_EFFORTS,
  isReasoningEffort,
  resolveReasoningParams,
} from "../reasoning.js";

// ---------------------------------------------------------------------------
// isReasoningEffort
// ---------------------------------------------------------------------------

test("isReasoningEffort: accepts all picker levels, rejects others", () => {
  for (const level of ["off", "low", "medium", "high", "max"]) {
    assert.equal(isReasoningEffort(level), true, level);
  }
  for (const bad of ["none", "xhigh", "on", "", undefined, 42, null]) {
    assert.equal(isReasoningEffort(bad), false, String(bad));
  }
});

test("REASONING_EFFORTS: cheapest-first superset covering every generation", () => {
  assert.deepEqual(REASONING_EFFORTS, ["off", "low", "medium", "high", "max"]);
});

// ---------------------------------------------------------------------------
// glm-5.3 — forced thinking, effort low/high/max only
// ---------------------------------------------------------------------------

test("glm-5.3 'off': maps to enabled + low with a notice (disabled is rejected)", () => {
  const result = resolveReasoningParams("glm-5.3", "off");
  assert.deepEqual(result.thinking, { type: "enabled", clear_thinking: true });
  assert.equal(result.reasoningEffort, "low");
  assert.match(result.notice ?? "", /cannot disable thinking/);
});

test("glm-5.3 'low'/'high'/'max': pass through with thinking enabled", () => {
  for (const effort of ["low", "high", "max"] as const) {
    const result = resolveReasoningParams("glm-5.3", effort);
    assert.deepEqual(result.thinking, { type: "enabled", clear_thinking: true });
    assert.equal(result.reasoningEffort, effort);
    assert.equal(result.notice, undefined);
  }
});

test("glm-5.3 'medium': mapped to high with a notice (no medium on 5.3)", () => {
  const result = resolveReasoningParams("glm-5.3", "medium");
  assert.equal(result.reasoningEffort, "high");
  assert.match(result.notice ?? "", /no 'medium'/);
});

test("glm-5.3 variant ids (glm-5.3-air etc.) are treated as always-thinking", () => {
  const result = resolveReasoningParams("glm-5.3-air", "off");
  assert.equal(result.thinking?.type, "enabled");
  assert.equal(result.reasoningEffort, "low");
});

// ---------------------------------------------------------------------------
// glm-5.2 — toggle + extended effort values
// ---------------------------------------------------------------------------

test("glm-5.2 'off': thinking disabled + reasoning_effort none (verified shape)", () => {
  const result = resolveReasoningParams("glm-5.2", "off");
  assert.deepEqual(result.thinking, { type: "disabled", clear_thinking: true });
  assert.equal(result.reasoningEffort, "none");
  assert.equal(result.notice, undefined);
});

test("glm-5.2 efforts: pass through with thinking enabled (server maps low/medium→high)", () => {
  for (const effort of ["low", "medium", "high", "max"] as const) {
    const result = resolveReasoningParams("glm-5.2", effort);
    assert.deepEqual(result.thinking, { type: "enabled", clear_thinking: true });
    assert.equal(result.reasoningEffort, effort);
    assert.equal(result.notice, undefined);
  }
});

// ---------------------------------------------------------------------------
// glm ≤ 5.1 — toggle only, no reasoning_effort field
// ---------------------------------------------------------------------------

test("glm-4.7 'off': thinking disabled + reasoning_effort none", () => {
  const result = resolveReasoningParams("glm-4.7", "off");
  assert.deepEqual(result.thinking, { type: "disabled", clear_thinking: true });
  assert.equal(result.reasoningEffort, "none");
});

test("glm ≤ 5.1 efforts: thinking enabled, no reasoning_effort, on/off notice", () => {
  for (const modelId of ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.5-air", "glm-4.6v"]) {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const result = resolveReasoningParams(modelId, effort);
      assert.deepEqual(
        result.thinking,
        { type: "enabled", clear_thinking: true },
        `${modelId}/${effort}`,
      );
      assert.equal(result.reasoningEffort, undefined, `${modelId}/${effort}`);
      assert.match(result.notice ?? "", /on\/off/, `${modelId}/${effort}`);
    }
  }
});

// ---------------------------------------------------------------------------
// non-GLM models
// ---------------------------------------------------------------------------

test("non-GLM models get no reasoning fields", () => {
  assert.deepEqual(resolveReasoningParams("gpt-9", "high"), {});
  assert.deepEqual(resolveReasoningParams("kimi-k2.7", "max"), {});
});
