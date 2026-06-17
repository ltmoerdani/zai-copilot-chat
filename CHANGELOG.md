# Changelog

All notable changes to the **Z.AI Copilot Chat** extension are documented here.

## 0.2.4 — 2026-06-17

### Added
- **Z.AI Coding Plan quota tracking** — when your API key belongs to a Z.AI Coding Plan subscription, the extension now fetches quota usage from `https://api.z.ai/api/monitor/usage/quota/limit` and displays it in the VS Code status bar. Auto-refreshes every 5 minutes (configurable via `zai.quotaRefreshInterval`). ([PR #2](https://github.com/ltmoerdani/zai-copilot-chat/pull/2) — @nik13513513)
- **Graphical quota tooltip** — hovering the quota status bar item shows a compact, centered SVG donut chart with two concentric rings: the outer ring represents the weekly quota, the inner ring the rolling 5-hour quota. Each ring is colour-coded: blue (normal), yellow (≥80%), red (≥95%). Below the chart: usage percentages and human-readable reset countdowns. ([PR #2](https://github.com/ltmoerdani/zai-copilot-chat/pull/2))
- **Quota status bar indicator** — new `$(graph) Z · NN%` status bar item (right side, priority 95) showing the current 5-hour or weekly quota usage percentage. Click to toggle between views. Background turns yellow at 80% and red at 95%. ([PR #2](https://github.com/ltmoerdani/zai-copilot-chat/pull/2))
- **New commands** — `Z.AI: Show Quota` opens a detailed markdown report of all quota windows; `Z.AI: Toggle Quota View` switches the status bar between 5-hour and weekly display. ([PR #2](https://github.com/ltmoerdani/zai-copilot-chat/pull/2))
- **New settings** — `zai.showQuotaStatusBar` (default `true`) and `zai.quotaRefreshInterval` (default `5` minutes; `0` disables auto-refresh). ([PR #2](https://github.com/ltmoerdani/zai-copilot-chat/pull/2))
- **Quota auth error class** — new `QuotaAuthError` sentinel error (with HTTP status) replaces brittle substring matching in the quota fetch retry loop, so auth failures (401/403) are detected reliably across both `Bearer` and raw-key auth attempts. ([PR #3](https://github.com/ltmoerdani/zai-copilot-chat/pull/3) — @nik13513513)
- **Markdown escaping** — new `escapeMarkdown()` helper safely escapes API-sourced strings (plan level, window names) before interpolating them into the quota tooltip, preventing Markdown injection rendering glitches. ([PR #3](https://github.com/ltmoerdani/zai-copilot-chat/pull/3))
- **Quota test suite** — new `src/test/quota.test.ts` (217 lines, 10 test cases) covering `parseQuotaSnapshot`, `pickHourlyQuota`/`pickWeeklyQuota`, `formatResetCountdown`, `quotaDonutSvg` (including clamping & undefined handling), `escapeMarkdown`, `QuotaAuthError` detection, and `fetchQuotaSnapshot` auth-retry flow with a mocked `globalThis.fetch`. ([PR #3](https://github.com/ltmoerdani/zai-copilot-chat/pull/3))
- **New module** — `src/quota.ts` (389 lines) with full quota parsing, formatting, SVG generation, and fetch logic. ([PR #2](https://github.com/ltmoerdani/zai-copilot-chat/pull/2))

### Changed
- **Status bar fallback** — when quota data is unavailable (no API key, fetch failed), the status bar now shows a persistent `$(graph) Z.AI quota` item with a helpful tooltip instead of hiding silently. ([PR #3](https://github.com/ltmoerdani/zai-copilot-chat/pull/3))
- **Retry loop clarity** — `fetchQuotaSnapshot`'s catch block now uses `isQuotaAuthError()` for branching instead of regex-matching error messages. ([PR #3](https://github.com/ltmoerdani/zai-copilot-chat/pull/3))

## 0.2.3 — 2026-06-14

### Added
- **GLM-5.2** — Z.AI's new flagship model is now bundled and available in the model picker. Features 1M-token context window, 128K max output tokens, and enhanced coding and long-horizon task capabilities. Automatically benefits from the 1.5× timeout multiplier used by all 200K+ context flagship models.

## 0.2.2 — 2026-06-09

### Fixed
- **"messages.content.type is invalid, allowed values: ['text']" (400)** — Z.AI's API rejects content arrays containing non-text parts (e.g. `image_url`). When VS Code sends conversation history containing `LanguageModelDataPart` instances (screenshots, image attachments), the extension previously forwarded them as `image_url` content parts, causing a hard 400 error. The `convertMessage()` function now strips unsupported content types and always produces plain-string content for Z.AI, eliminating the error.

## 0.2.1 — 2026-06-04

### Fixed
- **"Connection timed out after 120000ms" on flagship 200K models** — `glm-5.1`, `glm-5`, `glm-5-turbo`, and `glm-4.7` (200K-context flagship models) frequently timed out on long or cold requests because the default `zai.requestTimeout` (120s) and inactivity window (60s) were too aggressive for their cold-start latency.
- **Per-model timeout scaling** — the connection timeout and inactivity timer now auto-scale to **1.5×** for 200K-context flagship models (so a 180s base becomes 270s connection / 135s inactivity), while smaller 128K models keep 1× scaling. Effective ceiling is clamped to 300000ms (5 min) as the hard upper bound.
- **Inactivity timer floor raised to 90s** — the minimum inactivity window is now 90s (was 30s), so a slow first-token or large-context prefill won't kill the request mid-stream. Maximum is 180s.
- **Default `zai.requestTimeout` raised from 120000 → 180000ms** — 3 minutes is the new default, which is more realistic for flagship Z.AI models on busy or cold sessions.
- **Improved timeout error message** — when a timeout occurs, the error now includes a concrete hint when a flagship model is in use, and lists four actionable steps: (1) retry, (2) raise `zai.requestTimeout`, (3) try `glm-4.5-flash`, or (4) clear chat history.
- **Timeout-config logging** — each request now logs `[Timeout config: model=X flagship=Y multiplier=Z× connectionTimeout=…]` to the Z.AI Output channel, so you can see exactly which budget was applied per request.

## 0.2.0 — 2026-06-04

### Added
- **Token usage tracking** — each Z.AI API response now captures prompt, completion, and total token counts from the streaming response's final usage event
- **Usage status bar** — new `zai.showUsageStatusBar` setting (default `true`) shows a compact token summary in the VS Code status bar after each response (format: `Z.AI N→M (total) tok`). Hover to see full breakdown including cached tokens and model name.
- **Usage data emission** — token usage is emitted as `LanguageModelDataPart` into the Copilot Chat response stream. Includes both Copilot-native `usage` MIME type and Z.AI-specific `application/vnd.zai.usage+json`.
- **Experimental Copilot Chat context indicator** — new `zai.experimentalContextIndicator` setting (default `false`, opt-in) attempts to inject real Z.AI token usage into the Copilot Chat footer context display. Uses VS Code internal APIs and may break across updates.
- **Usage logging** — each request logs `[usage]` and `[response-summary]` lines to the Z.AI Output channel for diagnostics.

### Changed
- **Status bar auto-update** — the Z.AI status bar appears on the right side (priority 95) only after a response is received, and resets on new request start
- **Config change reactivity** — the extension now listens for `onDidChangeConfiguration` to toggle the status bar and experimental context indicator in real time

## 0.1.2 — 2026-05-31

### Changed
- **Extension icon redesigned** — replaced generic `</>` code symbol with a bold **Z** lettermark using the Z.AI brand gradient (violet → indigo → cyan) on a dark purple background, with a glow halo and cyan accent dot referencing the "Z." brand mark
- **Request timeout** — configurable timeout (default 120s) via `zai.requestTimeout` setting. Prevents requests from hanging indefinitely when the Z.AI API is slow or unresponsive.
- **Automatic retry with exponential backoff** — transient errors (network failure, timeout, 5xx, 429) are automatically retried up to `zai.maxRetries` times (default 2) with backoff: 1s → 2s → capped 10s.
- **Error classification** — `isRetryableError()` / `isNonRetryableHttpError()` helpers distinguish between transient and permanent errors. Client 4xx errors (except 429) are never retried. 5xx and 429 are retried.
- **New settings** — `zai.requestTimeout` (10,000–300,000ms) and `zai.maxRetries` (0–5) added to VS Code configuration.

### Fixed
- **"fetch failed" with no recovery** — network-level errors (connection reset, DNS failure, server timeout) previously crashed the request immediately. Now they are retried with backoff before surfacing to the user.
- **5-minute silent hangs** — `fetch()` previously had no timeout, so a hanging Z.AI API could block for up to ~5 minutes (VS Code's internal timeout). Now defaults to 120s with a clear `TimeoutError`.

## 0.1.1 — 2026-05-24

### Fixed
- **Context window overflow** — `advertisedMaxInputTokens` was inflated (328K) beyond the actual Z.AI model limit (200K), causing VS Code to delay conversation compaction until too late, resulting in repeated "Recovered from a request error" and "Sorry, no response was returned" failures during long chat sessions
- Corrected `modelLimits()` calculation: `advertisedMaxInputTokens = contextWindow - outputReserve` (184K for GLM-5/5.1) instead of `contextWindow + maxOutputTokens - UI_RESERVE`
- Replaced `UI_OUTPUT_TOKEN_RESERVE` (8K) with `OUTPUT_TOKEN_RESERVE` (16K) for safer compaction threshold
- **Corrected all model context windows and max output tokens** to match official [Z.AI docs](https://docs.bigmodel.cn/cn/guide/start/model-overview) — previously all values were inflated (e.g. 204,800 instead of 200,000 for context, 131,072 instead of 128,000 for output)
- **Added missing models** to `MODEL_LIMITS` and `BUNDLED_MODELS`: `glm-5-turbo`, `glm-4.6`, `glm-4.5`, `glm-4.5-airx`
- `DEFAULT_MODEL_LIMITS` fallback reduced from 204,800/131,072 to 128,000/128,000 (safe conservative default)

### Added
- **Request-time token budgeting** — estimates input tokens before each API call and dynamically adjusts `max_tokens` to fit within the context window (`min(maxOutputTokens, contextWindow - inputTokens)`)
- `estimateTotalTokens()` helper — counts tokens across text, tool calls, and reasoning content
- **Token budget logging** — each request logs `input≈N maxOut=M contextWindow=W` to the Z.AI Output channel
- **Overflow warning** — logs a `WARNING` when estimated input tokens approach or exceed the context window

### Model specs (from [Z.AI docs](https://docs.bigmodel.cn/cn/guide/start/model-overview))
| Model | Context | Max Output |
|---|---|---|
| GLM-5.1 / 5 / 5-Turbo / 4.7 / 4.6 | 200K | 128K |
| GLM-4.5 / 4.5-Air / 4.5-AirX / 4.5-Flash | 128K | 96K |
| GLM-5V-Turbo | 200K | 128K |
| GLM-4.6V / 4.6V-Flash | 128K | 32K |

## 0.1.0 — 2026-05-14

### Added
- Initial release of **Z.AI Copilot Chat** on VS Code Marketplace
- Z.AI GLM models registered via Language Model Chat Provider API
- Live model list fetched from Z.AI API on activation
- Bundled fallback model metadata table (context window + max output tokens per model)
- OpenAI-compatible chat completions endpoint with streaming support
- Tool-calling support for Copilot Agent mode
- **Vision/image support** — GLM-5V-Turbo, GLM-4.6V, and GLM-4.6V-Flash can receive images from Copilot Chat
- `Z.AI: Manage Provider` command — manage API key, refresh models, test connection
- `Z.AI: Set API Key` command — stores API key in VS Code Secret Storage
- `Z.AI: Diagnostics` command — renders a markdown report of all registered models
- Settings: `zai.temperature`, `zai.maxTokens`, `zai.maxInputTokens`, `zai.debugReasoning`
- Per-model token limit overrides via `zai.maxInputTokens` and `zai.maxTokens`
- `thinking: { type: "disabled" }` for GLM models to ensure normal text output
