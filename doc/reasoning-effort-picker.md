# Feature: Reasoning-Effort Picker (off / low / medium / high / max)

> **Status:** ✅ SHIPPED  
> **Date:** August 19, 2026  
> **Extension version:** 0.6.0 (ships together with the vision bridge as one release)  
> **Severity / Impact:** High — single biggest quota lever for Coding Plan users  
> **Context:** Follows the cost analysis on 2026-08-19 (z.ai implicit context caching exists, but reasoning tokens are billed as output — the always-thinking GLM-5.3 at the previous default `high` was the main quota burner). Pattern adapted from `opencode-copilot-chat`'s `GlmThinking` strategy (`src/thinking/glm.ts`), translated to z.ai-native dialects.

---

## Table of Contents

1. [Summary](#1-summary)
2. [Problem](#2-problem)
3. [Z.AI Reasoning Dialects per Generation](#3-zai-reasoning-dialects-per-generation)
4. [Solution](#4-solution)
5. [Code Changes](#5-code-changes)
6. [Verification](#6-verification)
7. [Related Fix — Test-Runner Glob](#7-related-fix--test-runner-glob)
8. [Sources](#8-sources)

---

## 1. Summary

The `zai.reasoningEffort` setting is now a five-level picker — **`off` / `low` / `medium` / `high` / `max`** — translated per model generation by a new pure module (`src/reasoning.ts`). A new **`Z.AI: Set Reasoning Effort`** command exposes the same levels from the Command Palette. The default changed from `high` (5.3-only, thinking force-disabled elsewhere) to **`off`**.

| Before (≤ 0.5.0) | After (0.6.0) |
|---|---|
| Enum `low \| high \| max`, default `high` | Enum `off \| low \| medium \| high \| max`, default `off` |
| Only affected GLM-5.3+ | Affects every GLM generation (see mapping) |
| GLM ≤ 5.2: thinking force-disabled, no way to enable | GLM ≤ 5.2: thinking follows the picker |
| No picker UI | `Z.AI: Set Reasoning Effort` QuickPick with cost hints |
| Silent behaviour | Translation notes logged to Output → Z.AI |

---

## 2. Problem

Findings from the 2026-08-19 cost analysis:

1. **z.ai has implicit context caching** (no request parameter; reported via `usage.prompt_tokens_details.cached_tokens`; cached input billed at ~81 % discount on GLM-5.3). The extension already surfaces this — cache is not the missing piece.
2. **Reasoning tokens are billed as output** (the most expensive tier). GLM-5.3 *cannot* disable thinking, and the previous default effort was `high` — every casual chat turn paid deep-reasoning prices.
3. **GLM ≤ 5.2 users had no reasoning control at all**: the extension hard-disabled thinking for these models, so picking a deeper effort was impossible even though the API supports it (`glm-5.2` accepts an extended `reasoning_effort` value set).
4. The old enum had no `off`/`medium`, and no picker UI existed — matching the level to the task required hand-editing JSON settings.

---

## 3. Z.AI Reasoning Dialects per Generation

Confirmed from official docs (retrieved 2026-08-19):

| Generation | `thinking.type` | `reasoning_effort` | Notes |
|---|---|---|---|
| **glm-5.3+** | `enabled` **only** (forced) | `low` \| `high` \| `max` | `disabled` is **rejected — request fails**. Migration guidance: replace `disabled` with `enabled` + `reasoning_effort: "low"`. |
| **glm-5.2** | `enabled` \| `disabled` | extended set: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none` | `none`/`minimal` → model skips thinking; `low`/`medium` → mapped to `high` by the server; `xhigh` → `max`. |
| **glm ≤ 5.1** (5.1, 5, 5-turbo, 4.7, 4.6, 4.5…) | `enabled` \| `disabled` | **unsupported** | Toggle only. |
| non-GLM | — | — | Endpoint is GLM-only; no reasoning fields sent. |

Additional behaviour kept from 0.4.0 (thinking-leak fix): `clear_thinking: true` is always sent so reasoning is not preserved in replayed context (Coding Plan default).

---

## 4. Solution

### Mapping table (implemented in `resolveReasoningParams`)

| Level | glm-5.3+ (forced thinking) | glm-5.2 | glm ≤ 5.1 (toggle only) |
|---|---|---|---|
| `off` | `enabled` + `low` + **notice** | `disabled` + `none` | `disabled` + `none` |
| `low` | `enabled` + `low` | `enabled` + `low` | `enabled` (no effort field) |
| `medium` | `enabled` + `high` + **notice** (5.3 has no medium) | `enabled` + `medium` (server maps → high) | `enabled` (no effort field) |
| `high` | `enabled` + `high` | `enabled` + `high` | `enabled` (no effort field) |
| `max` | `enabled` + `max` | `enabled` + `max` | `enabled` (no effort field) |

Design rules:

- **Never send an invalid value.** The resolver is the single source of truth for the dialect table; `extension.ts` just spreads the result into the request body.
- **Never translate silently.** When a level had to be adjusted (`off`/`medium` on glm-5.3, any effort on glm ≤ 5.1), a `notice` is returned and logged to the Z.AI output channel (`[Reasoning: …]`).
- **Backwards-compatible request shape.** `off` on glm-5.2 and below produces the exact payload the extension has always sent (`thinking: disabled` + `reasoning_effort: "none"` + `clear_thinking: true`).

### Cost guidance (picker descriptions)

- `off` — "Thinking disabled — cheapest & fastest"
- `low` — "Lightweight reasoning" (big quota saver for chat/Q&A)
- `medium` — "Balanced reasoning"
- `high` — "Enhanced reasoning — good default for coding"
- `max` — "Deepest reasoning (server default) — slowest, most tokens"

---

## 5. Code Changes

| File | Change |
|---|---|
| `src/reasoning.ts` **(new)** | Pure module: `ReasoningEffort` type, `REASONING_EFFORTS`, `isReasoningEffort` type guard, `resolveReasoningParams(modelId, effort)` → `{ thinking?, reasoningEffort?, notice? }`. No `vscode` import; doc-evidence-annotated header. |
| `src/test/reasoning.test.ts` **(new)** | 11 tests: full generation matrix (glm-5.3 + variants, glm-5.2 extended values, glm ≤ 5.1 toggle-only, non-GLM passthrough), notices asserted. |
| `src/extension.ts` | Request building delegates to `resolveReasoningParams`; notices logged; `ApiSettings.reasoningEffort` widened to the new type; `getSettings()` validates via `isReasoningEffort` (default `off`); new `zai.setReasoningEffort` command (QuickPick, persists globally). |
| `package.json` | Setting enum → 5 levels with `enumDescriptions` + markdown mapping table; default `off`; new command contribution. Version stays 0.6.0 — one bump shared with the vision bridge. |
| `CHANGELOG.md` | Merged into the single 0.6.0 entry (Added / Changed / Technical). |
| `README.md` | Feature table, model table, commands table, settings table, performance note. |

---

## 6. Verification

- `tsc -p ./` — clean (no errors in `reasoning.ts`, `extension.ts`, test file).
- `src/test/reasoning.test.ts` — 11/11 pass, covering every cell of the mapping table plus edge cases (glm-5.3 variant ids like `glm-5.3-air`, non-GLM models).
- Full suite — **151/151 pass** (see §7 for why the number moved from 118).
- Manual check list for the next live session: pick each level via `Z.AI: Set Reasoning Effort`, send a chat message, confirm `[Reasoning: …]` notice in Output → Z.AI for glm-5.3 `off`/`medium`, and confirm quota burn drop at `off`/`low`.

---

## 7. Related Fix — Test-Runner Glob

While verifying the new tests, an old bug surfaced: the `test` npm script used

```
node --test out/test/**/*.test.js
```

Under `sh` (no globstar), `**` behaves like `*`, so **top-level test files never ran** — `quota.test.ts`, `apiKeyState.test.ts` (and the new `reasoning.test.ts`) were silently skipped; the reported "118 passing" only covered `out/test/{research,vision}/`. Fixed to:

```
node --test out/test/*.test.js out/test/*/*.test.js
```

Full suite is now genuinely 151 tests. Lesson: always confirm a new test file **appears in the runner output**, not just that the count didn't drop.

---

## 8. Sources

- [Core Parameters — `reasoning_effort` & `thinking`](https://docs.z.ai/guides/overview/concept-param.md) — value sets per generation; GLM-5.2 extended values and server-side mapping; GLM-5.3 only `max/high/low`.
- [GLM-5.3 model page](https://docs.z.ai/guides/llm/glm-5.3.md) — forced thinking; migration notice (`disabled` → `enabled` + `low`, otherwise request fails).
- [Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode.md) — default-on thinking for GLM-5.x/4.7; `disabled` switch; `clear_thinking` / Preserved Thinking on the Coding Plan endpoint.
- [Context Caching](https://docs.z.ai/guides/capabilities/cache.md) — implicit caching, `cached_tokens` reporting (cost-analysis background).
- [Pricing](https://docs.z.ai/guides/overview/pricing) — cached-input discount, output-token pricing (cost-analysis background).
- `opencode-copilot-chat` — `src/thinking/glm.ts` (`GlmThinking`), `src/thinking/types.ts` (per-family `ThinkingSettings`) — the per-generation picker pattern this feature adapts.
- Prior art in this repo: `doc/zai-thinking-leak-fix.md` (0.4.0) — the multi-layer thinking suppression this builds on.
