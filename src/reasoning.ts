/**
 * Reasoning-effort resolution for Z.AI GLM models.
 *
 * CONTRACT: pure only — no `vscode` import, no side effects. Unit-testable.
 *
 * The single `zai.reasoningEffort` setting (off | low | medium | high | max)
 * is translated into request fields per model generation, because each GLM
 * generation speaks a different reasoning dialect:
 *
 * | Generation | `thinking.type`        | `reasoning_effort`                          |
 * | ---------- | ---------------------- | ------------------------------------------- |
 * | glm-5.3+   | `enabled` only (forced)| `low` \| `high` \| `max` (no medium/off)    |
 * | glm-5.2    | `enabled` \| `disabled`| extended: `none`/`minimal` skip thinking, `low`/`medium` → high, `xhigh` → max |
 * | glm ≤ 5.1  | `enabled` \| `disabled`| NOT supported (toggle only)                 |
 *
 * Evidence (retrieved 2026-08-19):
 * - https://docs.z.ai/guides/overview/concept-param.md — `reasoning_effort`
 *   "only supported by GLM-5.2 and above"; allowed values `max`, `high`,
 *   `low`; GLM-5.2 note: "`none` or `minimal` will cause the model to skip
 *   thinking; `low` and `medium` will be mapped to `high`"; GLM-5.3 note:
 *   "only supports `max`, `high`, `low`".
 * - https://docs.z.ai/guides/llm/glm-5.3.md — GLM-5.3 forced thinking;
 *   migration notice: replace `thinking.type: "disabled"` with `enabled` +
 *   `reasoning_effort: "low"`, otherwise the request FAILS.
 * - https://docs.z.ai/guides/capabilities/thinking-mode.md — thinking enabled
 *   by default on GLM-5.x/4.7; `disabled` turns it off (except GLM-5.3).
 */

/** User-selectable reasoning effort levels (picker + setting enum). */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

/** All valid setting values, cheapest first. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
  "max",
];

/** Type guard for values read from workspace configuration. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Thinking object shape sent to the Z.AI chat-completions endpoint. */
export interface ReasoningThinking {
  type: "enabled" | "disabled";
  /** Coding Plan default: do not preserve reasoning in replayed context. */
  clear_thinking: boolean;
}

/** Result of resolving a user effort level for one model. */
export interface ResolvedReasoning {
  /** `thinking` request field; `undefined` for non-GLM models. */
  thinking?: ReasoningThinking;
  /** `reasoning_effort` request field; `undefined` when unsupported/omitted. */
  reasoningEffort?: string;
  /** Human-readable note when the requested level had to be translated. */
  notice?: string;
}

/**
 * Models whose thinking cannot be disabled (GLM-5.3+ forced reasoning).
 * Mirrors `isAlwaysThinkingModel` in extension.ts — keep in sync.
 */
function isAlwaysThinkingModel(modelId: string): boolean {
  return modelId.startsWith("glm-5.3");
}

/** GLM-5.2: first generation with `reasoning_effort` (extended value set). */
function isEffortCapableModel(modelId: string): boolean {
  return modelId.startsWith("glm-5.2") || isAlwaysThinkingModel(modelId);
}

/**
 * Translate a user reasoning level into request fields for one model.
 *
 * Non-GLM models get no reasoning fields at all (the endpoint is GLM-only,
 * but the function stays total so it can be reused for future models).
 */
export function resolveReasoningParams(
  modelId: string,
  effort: ReasoningEffort,
): ResolvedReasoning {
  if (!modelId.startsWith("glm-")) {
    return {};
  }

  const enabled: ReasoningThinking = { type: "enabled", clear_thinking: true };
  const disabled: ReasoningThinking = { type: "disabled", clear_thinking: true };

  // "off" — disable thinking wherever the model allows it.
  if (effort === "off") {
    if (isAlwaysThinkingModel(modelId)) {
      // GLM-5.3 rejects `thinking.type: "disabled"` with a hard failure.
      // Official migration guidance: enabled + reasoning_effort "low".
      return {
        thinking: enabled,
        reasoningEffort: "low",
        notice:
          "glm-5.3 cannot disable thinking — 'off' was sent as reasoning_effort 'low' (lightweight reasoning).",
      };
    }
    // GLM ≤ 5.2: `thinking: disabled` + the `none` backup (verified shape —
    // the exact payload this extension has always sent for these models).
    return { thinking: disabled, reasoningEffort: "none" };
  }

  if (isAlwaysThinkingModel(modelId)) {
    // GLM-5.3: only low | high | max.
    if (effort === "medium") {
      return {
        thinking: enabled,
        reasoningEffort: "high",
        notice: "glm-5.3 has no 'medium' effort — sent as 'high' (enhanced reasoning).",
      };
    }
    return { thinking: enabled, reasoningEffort: effort };
  }

  if (modelId.startsWith("glm-5.2")) {
    // GLM-5.2 accepts the full extended value set; the server maps
    // low/medium → high and treats xhigh → max, transparently.
    return { thinking: enabled, reasoningEffort: effort };
  }

  // GLM ≤ 5.1: toggle-only — reasoning_effort is not supported.
  return {
    thinking: enabled,
    notice:
      "glm-5.1 and below only support thinking on/off — the effort level was ignored.",
  };
}
