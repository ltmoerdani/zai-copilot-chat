# Error 1261 & 429/1302 — Forensic Fix Report

**Date:** 2026-09-13 · **Release:** 0.6.3 · **Model in incident:** `glm-4.5-flash` · **Endpoint:** `https://api.z.ai/api/coding/paas/v4` (GLM Coding Plan)

---

## Timeline of the incident

| Time (UTC) | Symptom |
|---|---|
| Initial report | `Z.AI API request failed (400): {"error":{"code":"1261","message":"Prompt exceeds max length"}}` on `glm-4.5-flash` |
| After estimator fix | Same session now fails with `429 {"code":"1302","message":"Rate limit reached for requests"}` — 4 attempts, all dead within 6 seconds |
| After 429 backoff fix | Still failing — backoff code never executes (ERROR appears ~1.4s after Request, no `Retry ...` lines) |
| After regex fix | **Fully recovered.** `Retry 1/4 in 3008ms (rate limit)` → `4/4 in 15483ms` chain executes; request completes with `promptTokens=66700`; zero failures reach the user |

Three separate defects were stacked on top of each other. Each fix exposed the next.

---

## Defect 1 — Error 1261: "Prompt exceeds max length"

### Symptom

Long agent sessions on `glm-4.5-flash` (128K context tier) die with HTTP 400 / code `1261`. VS Code never compacted the conversation in time.

### Root causes (3 contributing factors)

1. **Token estimator under-counted.** `estimateTokenCount` collapsed internal whitespace (`value.replace(/\s+/g, " ")`) — but real tokenizers count indentation and separators in code/JSON tool results — and used `chars ÷ 4`, optimistic for code-heavy payloads. Combined under-count: ~20–30%.
2. **The request-level `tools` array was never counted.** In agent mode, tool schemas (descriptions + JSON Schema parameters) easily add 10–20K tokens to the server-side prompt; `estimateTotalTokens` only iterated `messages`.
3. **The advertised window had no margin.** For a 128K model, VS Code was told `maxInputTokens ≈ 111.6K` (128K − 16.4K output reserve). With the estimator running 20–30% low, VS Code believed it had room well past the point where the real prompt crossed 128K.

### Fixes

| Fix | Where | Detail |
|---|---|---|
| Estimator recalibration | `estimateTokenCount` | No whitespace collapse; `chars ÷ 3.5` (was ÷4). Calibrated against live telemetry — see [Calibration](#calibration-est-vs-real-prompttokens) below. |
| Tools schemas counted | `estimateToolsTokens` (new) | Iterates `options.tools` (name + description + `JSON.stringify(inputSchema)`), ×1.15 safety, added at both budget sites: `max_tokens` clamping in `streamChatCompletions` and the context-window buffer in `provideLanguageModelChatResponse`. |
| Advertised window margin | `modelLimits` | Models with `contextWindow ≤ 131072` advertise `⌊window × 0.75⌋` (96K for 128K models). VS Code compacts at ~67K real tokens — ~60K of headroom before the server limit. 200K/1M tiers unaffected. |
| 1261 runtime handler | catch in `provideLanguageModelChatResponse` | Detects `/"1261"|exceeds max length/i`, retries **once** with historical `reasoning_content` stripped from `apiMessages` (the largest safely-removable overhead). If that fails, an actionable message is shown: start a new chat / clear history / lower `zai.maxInputTokens`. |

### Calibration: est vs real `promptTokens`

| Local estimate | Server `promptTokens` | Overshoot |
|---|---|---|
| 106 149 (÷3 + ×1.15 — first attempt) | 66 696 | 1.59× (too high, premature compaction) |
| 94 826 (÷3.5, final) | 66 700 | 1.42× |
| 101 513 (÷3.5, final) | 70 148 | 1.45× |

The residual ~1.4× comes from the estimator counting the tools schemas on every request (server accounting may differ) and framing overhead. Deliberately left conservative: over-estimating costs a slightly earlier compaction; under-estimating costs a hard 400.

> **Tuning knob:** if compaction feels too aggressive, collect more `Token budget: input≈N` vs `[response-summary] promptTokens=M` pairs from the Z.AI output channel and adjust the `3.5` divisor accordingly.

---

## Defect 2 — Error 429/1302: rate-limited request bursts

### Symptom

Every turn, VS Code fires 3–4 requests nearly simultaneously — two tiny utility calls (~335 tokens: title generation, etc.) plus the main request (often 60–100K tokens). The coding endpoint's request-rate limiter rejects the burst:

```
429: {"error":{"code":"1302","message":"Rate limit reached for requests"}}
```

### Fixes

1. **Rate-limit-aware backoff** (`streamZaiResponse`) — when the previous error is a rate limit (`isRateLimitError`: message contains `429`, `"1302"`, or `rate limit`), the backoff base becomes `min(3000 × 2^(attempt−1), 15000)` instead of 1000-based, and the attempt budget grows by `RATE_LIMIT_EXTRA_ATTEMPTS = 2` (up to 5 total). Rationale from telemetry: the old 1s/2s cadence burned all retries **inside the same limiter window** (4 failures in 6s).
2. **Global request-start throttle** (`throttleRequestStart`) — a module-level promise chain spaces request **starts** ≥ `MIN_REQUEST_GAP_MS` (750ms) apart, defusing VS Code's parallel bursts without serializing the streaming responses (only the start is gated; streams still overlap). Post-fix log evidence: two same-second requests (messages=5 and 6) completed with **zero** 429s.

### Note: `cachedTokens=0` on vision models

All `glm-4.6v-*` requests show `cachedTokens=0` — the vision models do not support context caching. This means every turn (and every retry) is billed at full input-token cost, making vision sessions significantly more expensive than text-only sessions (where cache hit rates of 95–99% were observed on `glm-4.5-flash`).

---

## Defect 3 — Error 429/1305: server overload (distinct from rate limit)

### Symptom

After fixes 2 and 3 shipped, `glm-4.6v-flash` requests (large, ~55K tokens, no caching) started failing with a *different* 429 sub-code:

```
429: {"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}
```

Unlike the 1302 rate-limit (multi-second window), 1305 overload persisted **>1 minute** (glm-4.6v-flash, 2026-09-13: 04:50–04:57). The 3s→15s rate-limit backoff burned all 5 attempts in ~45s — still inside the overload window. Additionally, VS Code fires duplicate requests per turn (messages=11&12, 13&14, etc.), and during overload both retry *in lockstep* (same-second `Retry 1/4` lines), doubling the load on an already-struggling service.

### Fix

`isOverloadError` — a separate detector for `"1305" | "temporarily overloaded"`, with its own backoff and attempt budget:

| | 1302 rate limit | 1305 overload |
|---|---|---|
| Base | 3s | **4s** |
| Cap | 15s | **20s** |
| Extra attempts | +2 (5 total) | **+3 (6 total)** |
| Total window | ~40s | **~90s** |
| Rationale | Limiter window is multi-second | Server capacity exhaustion can outlast rate-limit chains |

Exhaustion error message: *"Z.AI servers are temporarily overloaded (error 1305) — ... requests were retried for ~90s without success. Try: (1) send again in a minute, (2) switch to another model, or (3) reduce request size."*

### What the extension cannot fix

Overload 1305 is a **server-side capacity** issue. When the endpoint is overloaded, the only reliable client-side mitigation is patience (backoff) or switching to a different model. In testing, `glm-4.5-flash` (text-only, 95–99% cache hit) was unaffected by the same outage, suggesting the vision model's inference pool has lower capacity.

---

## Defect 4 — CRITICAL: the retry path was dead code for 429

### Symptom

After Defect 2's fix shipped, logs still showed `ERROR ... 429` only ~1.4s after `Request:` — with **no** `Retry ... in Nms` lines. The new backoff never ran.

### Root cause

```ts
// isNonRetryableHttpError — before
return /\(4[0-8]\d\)/.test(error.message) || /\(400\)/.test(error.message);
```

The comment said *"4xx client errors (except 429) should not be retried"*, but the character class `[0-8]` matches the **second** digit — so `429` (4, 2∈[0-8], 9) matched the regex, `isNonRetryableHttpError` returned `true`, and the retry loop threw on the very first failure. Every 429 since this guard was written was never retried internally; the ~1.5s re-attempts users occasionally saw recover were **VS Code's own outer provider retries**, which masked the dead code.

### Fix

```ts
function isNonRetryableHttpError(error: Error): boolean {
  if (error.message.includes("429")) {
    return false; // rate limits are always retryable
  }
  return /\(4\d\d\)/.test(error.message);
}
```

### Verification (live log, post-fix)

```
Retry 1/4 in 3008ms (rate limit) after error: ... 429 ... 1302 ...
Retry 2/4 in 6124ms (rate limit) ...
Retry 3/4 in 12492ms (rate limit) ...
Retry 4/4 in 15483ms (rate limit) ...
[response-summary] promptTokens=66700 finishReason=tool_calls  ← recovered
```

---

## Lessons

1. **When a comment says "except X", unit-test the case X itself.** The regex bug survived every review because the intent was documented correctly while the implementation contradicted it.
2. **Verify retry logic by observing its log lines, not by absence of user failures** — VS Code's outer retries made dead retry code look like it worked.
3. **Calibrate token estimators against the server's `promptTokens`**, not against intuition: our first "conservative" recalibration (÷3 + 1.15×) was 1.59× high in the other direction.
4. **A limiter window is a duration, not a threshold** — retry cadence must exceed the window (3s base beat Z.AI's rate-limit window; 1s did not). And for overload (1305), the window can be >60s — even 15s cap was too short.
5. **Overload ≠ rate limit** — they share HTTP 429 but require different backoff strategies. Rate limits are about *your* behavior; overloads are about *theirs*. Backing off harder during overload is counterproductive — backing off *longer* (but slower) is not.
6. **No retry strategy can fix a capacity outage.** When the server is genuinely overloaded, the extension can be patient (90s backoff) but cannot create capacity. The user must switch models or wait.
4. **A limiter window is a duration, not a threshold** — retry cadence must exceed the window (3s base beat Z.AI's window; 1s did not).
5. **No retry strategy can fix a capacity outage.** When the server is genuinely overloaded, the extension can be patient (90s backoff) but cannot create capacity. The user must switch models or wait.
6. **Known-good numbers for this endpoint:** request-start gap ≥750ms avoids most 1302s; backoff 3s→15s with 5 attempts recovers rate limits in ≤~40s; backoff 4s→20s with 6 attempts (~90s) handles most overloads — but if the outage is longer, the user must wait or switch models.

## Related

- Endpoint & plan constraints: `https://docs.z.ai/devpack/overview` (coding endpoint officially serves glm-5.3 / glm-5.3-flash; glm-4.7 auto-routes to 5.3-flash)
- Original context-window overflow precedent: CHANGELOG 0.6.x — *"advertisedMaxInputTokens was inflated (328K) … causing repeated request failures"*
- Settings touched: `zai.maxInputTokens` (override), `zai.maxRetries` (base budget; rate limits +2, overload +3)
- Vision model economics: `glm-4.6v-flash` has `cachedTokens=0` on every request (no context caching) — each turn and retry is full-price; prefer `glm-5.3-flash` (native multimodal + context caching + 3× quota) for vision-heavy workloads.
