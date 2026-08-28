# GLM-5.3 Support

**Status:** implemented in 0.5.0 · **Date:** 2026-08-15 · **Type:** research + implementation note

## 1. What shipped

Z.AI released **GLM-5.3** (`glm-5.3`), the new flagship model.

| Spec | Value | Source |
|---|---|---|
| Model id | `glm-5.3` | model overview table |
| Context window | 1M (1,000,000) | docs.bigmodel.cn model overview |
| Max output | 128K (128,000) | docs.bigmodel.cn model overview |
| Modalities | Text only | GLM-5.3 page ("仅支持处理文本模态信息") |
| Coding | +50% vs GLM-5.2 on Z.ai Code Bench; Terminal-Bench 3.0 4.6 → 28.3; DeepSWE v1.1 46.2 → 66.9 | GLM-5.3 page |
| Security | CyberGym 84.5% (SOTA), ExploitBench 54.4% (2×+ GLM-5.2) | GLM-5.3 page |
| Availability | GLM Coding Plan — **live now**; general Model API "coming soon" | docs.z.ai devpack overview |

Key routing fact: *requests for GLM-5.2/GLM-5.1 are automatically routed to GLM-5.3* on the Coding Plan endpoint. Existing user selections therefore keep working and silently upgrade.

Docs:
- Model page: https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
- Coding Plan: https://docs.z.ai/devpack/overview

## 2. The breaking change: thinking cannot be disabled

GLM-5.3 removed the "off" switch for thinking:

- `thinking.type` accepts **`enabled` only** — `disabled` is rejected.
- `reasoning_effort` accepts `low` | `high` | `max` — `none` is rejected. Server default when omitted: `max`.
- Migration note from Z.AI: requests carrying `thinking.type: "disabled"` must switch to `enabled` **before** adopting model id `glm-5.3`, otherwise **the request fails**.

### Impact on this extension

`requestChatCompletion()` used to send, for **every** `glm-*` model:

```jsonc
{ "thinking": { "type": "disabled", "clear_thinking": true }, "reasoning_effort": "none" }
```

Sending that shape to `glm-5.3` fails outright. So adding the model id alone would have shipped a broken picker entry.

## 3. What we changed

1. **`src/extension.ts`**
   - `MODEL_LIMITS["glm-5.3"] = { contextWindow: 1_000_000, maxOutputTokens: 128_000 }` (1M tier, above `glm-5.2`).
   - `BUNDLED_MODELS` gains `glm-5.3` at the top (flagship first).
   - New `isAlwaysThinkingModel()` (`startsWith("glm-5.3")`) gates request shape:
     - GLM-5.3+ → `thinking: { type: "enabled", clear_thinking: true }` + `reasoning_effort: settings.reasoningEffort`
     - older GLM → unchanged `disabled` / `none`
   - `ApiSettings.reasoningEffort` + `getSettings()` validation (fallback `high`).
   - Timeout hint & flagship-multiplier comments mention `glm-5.3`.
2. **`src/research/researchParticipant.ts`**
   - `DEFAULT_SYNTHESIS_MODEL` → `glm-5.3`.
   - `ZaiChatLLM.complete()` adds the always-on-thinking request shape with pinned `reasoning_effort: "low"` — research makes many small LLM calls (query planning + chunk summaries), so depth is wasted latency there.
3. **`package.json`** — version 0.5.1, `zai.reasoningEffort` contribution, `synthesisModel`/`defaultModel`/`requestTimeout` copy updates, keyword `glm-5.3` + `glm-5.3-flash`, displayName "15+ GLM Models".
4. **`README.md`** — model table row, badges, settings table, troubleshooting, bundled-limits table.
5. **GLM-5.3-Flash** (`glm-5.3-flash`) — added in v0.5.1 as a bundled vision model: 1M context, 128K max output, always-thinking, native multimodal input. See [CHANGELOG](../CHANGELOG.md).

## 4. Design decisions

- **Default `reasoning_effort: "high"`, not `max`.** Z.AI recommends `max` for coding agents, but their own benchmark shows ~75K output tokens per task at `max` (vs ~2× fewer at lower effort). For interactive Copilot Chat, `high` balances depth and latency; power users can set `max`.
- **Reasoning stays invisible.** VS Code stable (1.118 typings) has no `LanguageModelResponseReasoningPart`, so reasoning_content is captured by the extractor and dropped (debug via `zai.debugReasoning`, `<think>`-leak filter unchanged). Tokens are billed regardless since thinking is mandatory.
- **`clear_thinking: true` kept** — reasoning is not replayed into follow-up turns, matching prior behaviour.
- **Research pins `low`.** Planning queries and chunk summaries don't need deep reasoning; `low` keeps deep-research runs snappy.
- **No new vendor/endpoint work.** Same Coding Plan base URL; `glm-5.3` rides the existing provider.

## 5. Verification

- `npm run compile` — clean.
- `npm test` — all unit tests pass (research pure modules + quota/apiKeyState).
- Live smoke test against the Coding Plan endpoint pending user run (model picker → `glm-5.3` → send a prompt; check **Output → Z.AI** for `[usage]` line and no `thinking.type` errors).
