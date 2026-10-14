# Feature: Per-Model "Thinking Effort" Picker in the VS Code Model Picker (OpenCode-style)

> **Status:** ✅ SHIPPED  
> **Date:** October 14, 2026  
> **Extension version at time of research:** 0.6.x (reasoning-effort picker shipped in 0.6.0)  
> **Environment:** VS Code stable 1.13x, macOS arm64, Z.AI international endpoint (`api.z.ai`)  
> **Goal:** Reproduce the **OpenCode Go model-picker UX** — a `Thinking Effort: Off / Low / High / Max` selector rendered inside the model picker details popup (see user screenshot, OpenCode Go / Deepseek V4.1 Flash popup) — for Z.AI GLM models in this extension, **per model, chosen at pick time**, instead of (or in addition to) the global `zai.reasoningEffort` setting.

---

## Table of Contents

1. [Summary](#1-summary)
2. [Current State in This Extension](#2-current-state-in-this-extension)
3. [How OpenCode Does It — the Mechanism](#3-how-opencode-does-it--the-mechanism)
4. [Key Finding — No Proposed API Required](#4-key-finding--no-proposed-api-required)
5. [Compatibility With Our Reasoning Dialect Table](#5-compatibility-with-our-reasoning-dialect-table)
6. [Implementation Plan](#6-implementation-plan)
7. [Risks & Caveats](#7-risks--caveats)
8. [Sources](#8-sources)

---

## 1. Summary

The "Thinking Effort" chips in the OpenCode model picker are **not an OpenCode invention** — they are VS Code's **per-model configuration options**, driven by two fields of the Language Model Chat Provider API:

| Piece | API surface | Who fills it |
|---|---|---|
| Declare options per model | `LanguageModelChatInformation.configurationSchema` (JSON-schema-like: `enum`, `enumItemLabels`, `enumDescriptions`, `group`, `default`) | The extension, when advertising models in `provideLanguageModelChatInformation` |
| Receive the user's choice per request | `options.modelConfiguration` on `ProvideLanguageModelChatResponseOptions` | VS Code, when a chat request is made — the extension reads it at request time |

VS Code renders every `configurationSchema` property as a labeled chip row ("Thinking Effort") in the model picker details popup, together with pricing details. When the user changes the value, VS Code persists it in the **language models configuration file** (per model + vendor) and replays it into every subsequent request via `modelConfiguration`. No settings-GUI work, no QuickPick persistence — the UI is VS Code-native.

Our extension already ships the **wire-logic** half (the `src/reasoning.ts` dialect table translating `off/low/medium/high/max` → `thinking` + `reasoning_effort` per GLM generation). What is missing is only the **UI plumbing**: declare the schema on each advertised model and read the per-request override in `provideLanguageModelChatResponse`.

## 2. Current State in This Extension

- `zai.reasoningEffort` (global setting, enum `off | low | medium | high | max`, default `off`) → resolved by `resolveReasoningParams(modelId, effort)` in `src/reasoning.ts`; `extension.ts` spreads `thinking` / `reasoning_effort` into the request body (`extension.ts` ~line 1699–1713).
- `Z.AI: Set Reasoning Effort` QuickPick command writes the global setting.
- The model picker `detail` line shows the **current** level via `describeReasoning` (`extension.ts:1336`), but changing it requires settings or the command.
- `provideLanguageModelChatInformation` already handles the BYOK `configuration` group call (`extension.ts:1265–1291`) and its comment already anticipates per-model settings ("The per-model settings still apply at request time via `modelConfiguration`") — **but nothing reads `modelConfiguration` yet**.
- `@types/vscode` is pinned to `^1.118.0` — **does not declare** `configurationSchema` / `modelConfiguration` (verified by grep).

## 3. How OpenCode Does It — the Mechanism

Evidence from the local clone `~/Startup/opencode-copilot-chat`:

**a) Schema per model — `src/provider/settings.ts::modelConfigurationSchema()`**

```ts
const builtinSchema = thinkingProviderFor(modelId, metadata).schema(metadata);
if (builtinSchema) Object.assign(properties, builtinSchema.properties);
// ... plus contextSize options
return { type: "object", properties };
```

**b) Property shape — `src/thinking/schema.ts::effortProperty()`** (exactly what VS Code's popup renders):

```ts
{
  type: "string",
  title: "Thinking Effort",
  enum: ["off", "high", "max"],
  enumItemLabels: ["Off", "High", "Max"],
  enumDescriptions: ["Fastest responses", "Greater reasoning depth", "Maximum reasoning effort"],
  default: "off",
  group: "navigation",
}
```

**c) GLM family schema — `src/thinking/glm.ts`:**

- Normal GLM: `off / high / max` (default `off`).
- GLM 5.3+ (forced thinking, `disabled` is rejected): schema only exposes `high / max`, default `high`; and `normalize()` defensively rewrites a stale `off` → `high` so an invalid payload can never reach the wire.

**d) Attachment point — `src/provider/modelInfo.ts:178,204`:** the schema is spread onto the `LanguageModelChatInformation` as `configurationSchema` when the model is advertised.

**e) Read-back — `src/provider/settings.ts::getRequestModelConfiguration()`:**

```ts
const opts = options as vscode.ProvideLanguageModelChatResponseOptions & {
  modelConfiguration?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
};
return opts.modelConfiguration ?? opts.configuration; // older builds
```

The `?? configuration` fallback is a **defensive shim**: older VS Code builds shipped the field under `configuration`, so OpenCode accepts both shapes.

## 4. Key Finding — No Proposed API Required

OpenCode's `package.json` has **no `enabledApiProposals`** — the feature works on **stable** builds. The fields were migrated out of the `chatProvider` proposal into stable (`ProvideLanguageModelChatResponseOptions.modelConfiguration`, `LanguageModelChatInformation.configurationSchema`). OpenCode only vendors `src/vscode.proposed.chatProvider.d.ts` (version 6) to get **TypeScript types** while staying on `@types/vscode ^1.125.0`.

Implication for us, two options (either works):

1. **Preferred:** bump `@types/vscode` (and `engines.vscode`) to a recent stable version that declares both fields natively. Verify with a grep for `modelConfiguration` in `node_modules/@types/vscode/index.d.ts` after bumping.
2. **Fallback (zero-dependency):** copy OpenCode's approach — vendor a small local `.d.ts` (like our existing `src/vscode.proposed.languageModelThinkingPart.d.ts`) declaring the two interfaces, and cast at the call sites. Keeps `engines` untouched.

## 5. Compatibility With Our Reasoning Dialect Table

Our `resolveReasoningParams` is already a **superset** of OpenCode's GLM strategy, so the per-pick values map 1:1:

| Picker value | glm-5.3+ (forced) | glm-5.2 | glm ≤ 5.1 |
|---|---|---|---|
| `off` | → `enabled` + `low` (+notice) | `disabled` + `none` | `disabled` + `none` |
| `low` / `medium` / `high` / `max` | full support (`medium` → `high` +notice) | full support | toggle-only (notice) |

One design decision diverges from OpenCode: they hide `off` entirely for GLM 5.3 (schema only `high | max`). We instead **expose `off` and translate it to `low` with a notice** — because our users rely on the quota-saving "lightweight reasoning" mode. Keep our behavior; the schema enum per model should be:

- `glm-5.3*`: `off | low | high | max` (default `off` — matches our global default)
- other GLM: `off | low | medium | high | max` (default `off`)

## 6. Implementation Plan

> **Implemented 2026-10-14** via option 2 (vendored `src/vscode.proposed.chatProvider.d.ts`), `effortSchemaProperty()` in `src/reasoning.ts`, schema attachment + `modelConfiguration` override in `src/extension.ts`, 5 new unit tests. Verified: `tsc` clean, 177/177 tests pass. The read-back accepts the legacy `configuration` shape only when it carries a `reasoningEffort` key (never mistakes an auth config object for model settings).

1. **Types** — bump `@types/vscode` (option 1) or vendor the local d.ts (option 2, ≤ 30 lines: `LanguageModelConfigurationSchema`, `configurationSchema` on `LanguageModelChatInformation`, `modelConfiguration` on `ProvideLanguageModelChatResponseOptions`).
2. **`src/reasoning.ts`** (pure, no `vscode` import — keep the contract): add
   - `effortSchemaProperty(modelId: string): Record<string, unknown>` — returns the `reasoningEffort` property object with the per-generation enum (§5).
   - Unit tests in `src/test/reasoning.test.ts`.
3. **`src/extension.ts`**:
   - In the `models.map(...)` of `provideLanguageModelChatInformation`, add `configurationSchema: { type: "object", properties: { reasoningEffort: effortSchemaProperty(modelId) } }`.
   - In `provideLanguageModelChatResponse`, read
     `const perModel = (options as {modelConfiguration?: Record<string, unknown>}).modelConfiguration?.reasoningEffort;`
     validate with `isReasoningEffort(perModel)`, and resolve the effective effort as `perModel ?? settings.reasoningEffort`. Thread it into the existing `resolveReasoningParams(modelId, effective)` call (today it reads `settings.reasoningEffort` directly at ~line 1708 — pass the override down through `streamChatCompletions` or resolve before the call).
   - Update the `opts?.configuration !== undefined` early-return comment/behavior: a configuration group call carrying only `settings` (no key) must still not duplicate models — already handled.
4. **Docs**: README settings/commands table gets a "per-model Thinking Effort (model picker)" row; CHANGELOG entry.
5. **Keep the QuickPick + global setting** — they remain the fallback when the installed VS Code predates the fields (schema is silently ignored by old builds; global setting still applies).

## 7. Risks & Caveats

> **Follow-up (same release):** a `zai.verboseLogs` setting (default `false`) was added to keep the output channel clean — the per-request `Reasoning:` override line and one `[usage]` line always show; model-advertisement, token-budget, timeout-config and request-lifecycle lines are gated behind the flag (duplicate `[usage]` lines and the redundant `[response-summary]` line were removed outright). The deprecated `managementCommand` provider property was also dropped (built-in manage UI now suffices; `Z.AI: Manage Provider` remains a Command Palette command).

- **VS Code version gate:** if `engines.vscode` stays `^1.118.0` while the fields only render on newer builds, the schema is ignored silently on old hosts — acceptable (graceful degradation), but the README should state "Thinking Effort chips require VS Code ≥ 1.12x".
- **Type drift:** the OpenCode shim accepts both `modelConfiguration` and `configuration` on request options — replicate the `??` fallback so the picker keeps working across VS Code versions.
- **Never send an invalid value:** validate the read-back with `isReasoningEffort` before use; on an unrecognized value fall back to the global setting (defensive, mirrors OpenCode's `normalize()`).
- **`detail` line staleness:** `describeReasoning` reflects the global setting, not the per-model pick — VS Code renders the actual chip state itself, so consider trimming the reasoning info from `detail` to avoid showing two "truths".
- **Agent-variant providers:** if a second provider vendor is ever registered, the `modelConfiguration` is scoped per vendor — no cross-talk, but both providers need the schema.

## 8. Sources

- Local clone `~/Startup/opencode-copilot-chat`: `src/thinking/glm.ts`, `src/thinking/schema.ts`, `src/provider/settings.ts` (`modelConfigurationSchema`, `getRequestModelConfiguration`), `src/provider/modelInfo.ts` (attachment), `src/vscode.proposed.chatProvider.d.ts` (type contract, version 6).
- This repo: `src/reasoning.ts`, `src/extension.ts` (model advertisement ~1265–1345, request build ~1699–1713, QuickPick ~2755–2823), `doc/reasoning-effort-picker.md` (dialect table + evidence links: docs.z.ai `concept-param.md`, `glm-5.3.md`, `thinking-mode.md`).
