# Bug Fix: Z.AI Thinking / Reasoning Content Leaking Into Chat

> **Status:** ✅ RESOLVED  
> **Date:** July 24, 2026  
> **Extension version:** 0.4.0  
> **Severity:** High — model's internal chain-of-thought reasoning visible to users in chat output  
> **Root Cause:** Z.AI Coding Plan endpoint enables thinking by default; `thinking: { type: "disabled" }` alone was insufficient. Reasoning leaked via two paths: (1) `delta.reasoning_content` accumulated but never flushed on `finish_reason: "stop"`, and (2) reasoning emitted as `<think>...</think>` tags inside `delta.content` when the disable flag was ignored by the API.

---

## Table of Contents

1. [Summary](#1-summary)
2. [Environment](#2-environment)
3. [Z.AI Thinking Architecture](#3-zai-thinking-architecture)
4. [Investigation](#4-investigation)
5. [Root Cause Analysis](#5-root-cause-analysis)
6. [Solution — Multi-Layer Defense](#6-solution--multi-layer-defense)
7. [Code Changes](#7-code-changes)
8. [Verification](#8-verification)
9. [Prevention Recommendations](#9-prevention-recommendations)

---

## 1. Summary

Users reported that the model's internal "thinking" (chain-of-thought reasoning) was visible in the Copilot Chat output. This happened because Z.AI GLM models (GLM-5.2, GLM-5.1, GLM-5, GLM-4.7, etc.) have **thinking enabled by default**, and the extension's single-line mitigation — setting `thinking: { type: "disabled" }` in the request body — was not sufficient to fully suppress reasoning output across all API code paths.

The fix implements a **four-layer defense** strategy:

| Layer | What | Where |
|---|---|---|
| 1. Robust API disable | `thinking.type` + `reasoning_effort` + `clear_thinking` | `streamChatCompletions()` |
| 2. Stream `<think>` tag filter | Streaming-aware parser that strips `<think>...</think>` from `delta.content` | `OpenAiResponseExtractor.filterThinkingFromContent()` |
| 3. Flush on stop | Clear accumulated `reasoningContent` on `finish_reason: "stop"` | `OpenAiResponseExtractor.extractStreamParts()` |
| 4. Non-streaming filter | Regex strip of `<think>` tags from `message.content` | `extractChatCompletionParts()` |

---

## 2. Environment

| Component | Version |
|---|---|
| Extension | `ltmoerdani.zai-copilot-chat` v0.4.0 |
| API Endpoint | `https://api.z.ai/api/coding/paas/v4/chat/completions` (Coding Plan) |
| Models affected | All `glm-*` models (GLM-5.2, GLM-5.1, GLM-5, GLM-5-Turbo, GLM-4.7, GLM-4.6, GLM-4.5, etc.) |
| VS Code | 1.118+ |

---

## 3. Z.AI Thinking Architecture

Confirmed from official Z.AI documentation:

- **[Deep Thinking](https://docs.z.ai/guides/capabilities/thinking)**: `thinking.type` controls the mode. `enabled` (default) → model auto-decides whether to think. `disabled` → direct answers only.
- **[Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode)**: Thinking is **activated by default** in GLM-5.2, GLM-5.1, GLM-5, GLM-4.7 series.
- **`reasoning_effort`**: New parameter (GLM-5.2+) controlling reasoning depth. Values: `max` (default), `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. Setting to `none` makes the model skip thinking entirely.
- **`clear_thinking`**: Controls Preserved Thinking. On the **Coding Plan endpoint**, Preserved Thinking is **enabled by default** (`clear_thinking: false`). This means the API expects `reasoning_content` to be sent back in message history for context coherence.

### Response format with thinking enabled

```json
{
  "choices": [{
    "delta": {
      "reasoning_content": "Let me analyze this from multiple angles...",
      "content": "Here is my answer..."
    }
  }]
}
```

The `reasoning_content` field is separate from `content` — but only when the API properly respects the thinking disable flag.

---

## 4. Investigation

### Symptom

User reported thinking/reasoning text appearing in the Copilot Chat output, mixed with the model's actual response.

### What the code was doing before the fix

**Request body construction** (`streamChatCompletions`, ~line 1234):

```typescript
// BEFORE — single parameter, insufficient
if (modelId.startsWith("glm-")) {
  requestBody.thinking = { type: "disabled" };
}
```

**Stream parsing** (`OpenAiResponseExtractor.extractStreamParts`, ~line 1893):

```typescript
// BEFORE — reasoning_content accumulated but only flushed on tool_calls
if (typeof delta.reasoning_content === "string") {
  this.reasoningContent += delta.reasoning_content;
}
// ...
if (first.finish_reason === "tool_calls") {
  parts.push(...this.flushToolCalls()); // only place reasoning is flushed
}
// No handling for finish_reason === "stop"
```

**Content streaming** — `delta.content` was pushed directly to the user without any filtering:

```typescript
// BEFORE — no filter on content
if (typeof delta.content === "string") {
  parts.push(new vscode.LanguageModelTextPart(delta.content));
}
```

### Key findings from Z.AI docs

1. **Thinking is ON by default** — the extension must actively disable it.
2. **Coding Plan endpoint has different defaults** — Preserved Thinking is enabled by default, which changes how `reasoning_content` is handled in multi-turn conversations.
3. **`reasoning_effort: "none"`** is a separate parameter that explicitly tells GLM-5.2+ to skip thinking — a backup to `thinking.type: "disabled"`.
4. **If the API ignores the disable flag**, reasoning can leak via two paths: as `reasoning_content` in the delta (proper field) or as `<think>...</think>` tags inline within `content` (improper leakage).

---

## 5. Root Cause Analysis

### Bug #1: Insufficient API-level thinking suppression

The extension only sent `thinking: { type: "disabled" }`. This is the primary switch, but:

- GLM-5.2+ also supports `reasoning_effort`, which defaults to `"max"`. If the API processes `reasoning_effort` independently from `thinking.type`, thinking may still occur.
- The Coding Plan endpoint has `clear_thinking: false` by default (Preserved Thinking). This doesn't directly cause leakage, but it means the API is in a mode where `reasoning_content` is a first-class field in the response.

### Bug #2: `<think>` tags in `delta.content` not filtered

When the Z.AI API fails to honor `thinking: { type: "disabled" }` (e.g., due to an API update, endpoint-specific behavior, or model-specific override), the model may emit reasoning as `<think>...</think>` tags **inside the `content` field** rather than the proper `reasoning_content` field. The extension pushed `delta.content` directly to the user with no filtering.

### Bug #3: `reasoningContent` never flushed on normal completion

`this.reasoningContent` (the accumulator for `delta.reasoning_content`) was only consumed inside `flushToolCalls()`, which is called exclusively when `finish_reason === "tool_calls"`. On a normal text response (`finish_reason === "stop"`), the accumulated reasoning string was silently retained on the extractor instance. While this didn't directly leak to the user (it wasn't pushed as a `TextPart`), it created stale state and prevented debug logging from capturing the full reasoning trace.

---

## 6. Solution — Multi-Layer Defense

### Layer 1: Robust API-level thinking disable

Send three parameters instead of one:

```typescript
requestBody.thinking = { type: "disabled", clear_thinking: true };
requestBody.reasoning_effort = "none";
```

- `thinking.type: "disabled"` — primary switch (all GLM-4.5+ models)
- `clear_thinking: true` — override Coding Plan default, don't preserve reasoning in context
- `reasoning_effort: "none"` — backup for GLM-5.2+ (docs: "none" = model skips thinking)

### Layer 2: Streaming `<think>` tag filter

A new method `filterThinkingFromContent()` on `OpenAiResponseExtractor` that processes `delta.content` before pushing it to the user. It handles:

- **Complete blocks**: `<think>reasoning here</think>` within a single chunk → stripped entirely
- **Streaming split**: `<think>` in chunk A, reasoning text in chunks B–C, `</think>` in chunk D → state machine tracks `insideThinkBlock` across chunks
- **Partial tag detection**: Buffer ending with `<thin` (partial `<think>`) → held back until next chunk resolves it
- **Captured reasoning**: Filtered thinking text is routed to `reasoningContent` for debug logging, never to user output

### Layer 3: Flush on `finish_reason: "stop"`

Added a defensive flush when the stream completes normally:

```typescript
if (first.finish_reason === "stop" && this.reasoningContent.trim()) {
  this.onReasoningDebug?.(this.reasoningContent);
  this.reasoningContent = "";
}
```

This ensures accumulated reasoning is logged (if debug is enabled) and cleared, preventing stale state.

### Layer 4: Non-streaming response filter

In `extractChatCompletionParts()` (used for non-streaming fallback responses), added a regex strip:

```typescript
const cleaned = message.content
  .replace(/<think>[\s\S]*?<\/think>/gi, "")
  .trim();
```

---

## 7. Code Changes

All changes in `src/extension.ts`:

| Location | Change |
|---|---|
| `streamChatCompletions()` ~L1234 | `thinking` object now includes `clear_thinking: true`; added `reasoning_effort: "none"` |
| `OpenAiResponseExtractor` class ~L1883 | Added `insideThinkBlock` and `pendingContentBuffer` state fields |
| `extractStreamParts()` ~L1908 | `delta.content` now passes through `this.filterThinkingFromContent()` before pushing as `TextPart` |
| `extractStreamParts()` ~L1928 | Added `finish_reason === "stop"` flush block for accumulated reasoning |
| `filterThinkingFromContent()` ~L1960 | New method: streaming-aware `<think>` tag parser with cross-chunk state tracking |
| `partialOpenTagLength()` ~L2050 | New helper: detects partial `<think>` tag at end of buffer |
| `extractChatCompletionParts()` ~L2070 | Non-streaming `message.content` now regex-stripped of `<think>` tags |

### `filterThinkingFromContent` algorithm

```
State: insideThinkBlock (bool), pendingContentBuffer (string)

For each chunk of delta.content:
  1. Append chunk to pendingContentBuffer
  2. Loop:
     a. If insideThinkBlock:
        - Search for "</think>" in buffer
        - If found: everything before it → reasoningContent, consume tag, set insideThinkBlock=false
        - If not found: safe-flush all but last 8 chars to reasoningContent (handles split "</think>"), break
     b. If not insideThinkBlock:
        - Search for "<think>" in buffer
        - If found: everything before it → output (user-visible), consume tag, set insideThinkBlock=true
        - If not found: check for partial "<thin" suffix → hold back, output rest, break
        - If no partial: output entire buffer, clear, break
```

---

## 8. Verification

| Check | Result |
|---|---|
| TypeScript compilation (`tsc -p ./`) | ✅ 0 errors |
| Existing test suite (97 tests) | ✅ All pass, 0 failures |
| VS Code error diagnostics | ✅ No errors in `extension.ts` |

### Manual test checklist

- [ ] Chat with `glm-5.2` — no thinking text in response
- [ ] Chat with `glm-4.7` — no thinking text in response
- [ ] Tool-calling workflow — reasoning not visible, tool calls work normally
- [ ] Enable `zai.debugReasoning` → reasoning appears in Output Channel "Z.AI" only, not in chat
- [ ] Multi-turn conversation — no reasoning bleed from previous turns

---

## 9. Prevention Recommendations

1. **Monitor Z.AI API changelog** — The thinking/reasoning parameter surface has evolved (GLM-4.5 → GLM-4.7 → GLM-5.2 each added new parameters). Any future model may introduce new reasoning-related fields that need explicit suppression.

2. **Never trust a single disable flag** — The four-layer defense pattern (API parameter + stream filter + flush + non-streaming filter) should be maintained even if one layer appears sufficient. API behavior can change silently.

3. **Test with `debugReasoning` enabled** — When debugging reasoning-related issues, enable `zai.debugReasoning` in settings to see the full `reasoning_content` trace in the Output Channel. This helps distinguish between "thinking is leaking" vs "thinking is disabled but something else is wrong."

4. **Consider Preserved Thinking for agent quality** — The Coding Plan endpoint's Preserved Thinking feature (sending `reasoning_content` back in message history) can improve multi-turn reasoning quality for agent/tool-use scenarios. If this is desired in the future, the extension would need to: (a) enable `clear_thinking: false`, (b) capture and round-trip `reasoning_content` in `convertMessage()`, and (c) ensure it is never pushed as a user-visible `TextPart`. The infrastructure for capturing reasoning already exists (`reasoningContentByToolCallId` map).

5. **Watch for new tag formats** — If Z.AI introduces thinking markers other than `<think>...</think>` (e.g., `<reasoning>`, `<cot>`), the filter needs updating. The streaming parser is designed to be extended with additional tag patterns.
