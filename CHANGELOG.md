# Changelog

All notable changes to the **Z.AI Copilot Chat** extension are documented here.

## 0.3.1 — 2026-06-27

### Fixed (critical — MCP tools leaked to Copilot Agent)

This release fixes a critical regression where Z.AI's MCP tools (`web_search_prime`, `webReader`) were visible to **all** Copilot Agent sessions, not just `@z-research`. When the user asked Copilot Agent to do research in a normal chat, the agent auto-discovered the tools, spawned sub-agents to invoke them, and got stuck on slow MCP calls.

**What was broken (v0.3.0):**

1. **Global `mcp.json` entries** — The `Z.AI: Setup MCP Servers` command wrote `zai-web-search-prime` and `zai-web-reader` to the user's global `mcp.json`. VS Code's tool infrastructure discovers all servers in `mcp.json` and makes them available to every chat participant, including the default Copilot Agent.

2. **`mcpServerDefinitionProvider` (intermediate attempt)** — The first fix attempt replaced `mcp.json` with a scoped `vscode.lm.registerMcpServerDefinitionProvider`. However, **any** MCP registration — whether via `mcp.json` or via the API — makes the tools discoverable by VS Code's tool infrastructure. There is no "register but hide from Agent" mode. Copilot Agent still auto-discovered and invoked the tools.

**The fix — direct HTTP, zero VS Code MCP registration:**

`McpToolInvoker` now calls the Z.AI Streamable HTTP MCP endpoints **directly via `fetch()`**, completely bypassing VS Code's MCP tool infrastructure:

```
POST https://api.z.ai/api/mcp/web_search_prime/mcp
Content-Type: application/json
Authorization: Bearer <api-key from SecretStorage>

{"jsonrpc":"2.0","method":"tools/call","params":{"name":"web_search_prime","arguments":{...}}}
```

The tools are now **completely invisible** to VS Code's tool infrastructure. Only `@z-research` can invoke them. Regular Copilot Agent chat is 100% unaffected — no sub-agents, no stuck sessions.

**What was removed:**
- `Z.AI: Setup MCP Servers` command (no longer writes `mcp.json`)
- `contributes.mcpServerDefinitionProviders` in `package.json`
- `vscode.lm.registerMcpServerDefinitionProvider` in `index.ts`
- `vscode.lm.invokeTool` and `vscode.lm.tools` in `mcpTools.ts`
- `toolInvocationToken` threading through the orchestrator (no longer needed)
- `resolveToolName()` fuzzy matching (no longer needed — tool names are static)
- `listAvailableTools()` method (no VS Code tool list to query)
- `mcpToolNameResolver.ts` is now dead code (kept for historical reference)

**What was changed:**
- `McpToolInvoker.webSearch()` and `webRead()` now call `fetch()` directly
- `McpToolInvoker.isReady()` is now `async` — checks API key in SecretStorage instead of `vscode.lm.tools`
- `McpToolInvokerOptions` requires a `secrets: vscode.SecretStorage` field
- SSE response parsing for `text/event-stream` responses (Streamable HTTP transport)
- `researchParticipant.ts` updated for async `isReady()` and simpler error message

### Migration
- If you previously ran `Z.AI: Setup MCP Servers`, remove the `zai-web-search-prime` and `zai-web-reader` entries from your `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%\Code\User\mcp.json` (Windows), or `~/.config/Code/User/mcp.json` (Linux). The extension now calls the Z.AI MCP HTTP endpoints directly — these servers no longer need to be in the global config.

### Lesson learned
**VS Code MCP infrastructure is globally discoverable.** There is no way to register an MCP server that is visible to one chat participant but hidden from another. If you need scoped MCP tools (only invocable by your extension, not by Copilot Agent), you must call the MCP server's HTTP endpoint directly via `fetch()` and bypass `vscode.lm` entirely.

## 0.3.0 — 2026-06-26

### Added
- **Deep research via `@z-research` chat participant** — orchestrates Z.AI's MCP Web Search and Web Reader tools across multiple iterations to produce cited research reports with hundreds of sources, far beyond Copilot's 2-3 link limit.
- **5-phase orchestrator** — plan queries → parallel search → read top URLs → rank by BM25+recency → map-reduce synthesize with inline `[n]` citations.
- **Real-time progress reporting** — `parallelSearch` is an async generator that yields a phase per completed query, so the chat shows progress as each search finishes instead of one big batch update.
- **`Z.AI: Setup MCP Servers` command** — one-time setup that writes the user's `mcp.json` with Z.AI's official Web Search + Web Reader Streamable HTTP servers. No more dropdown noise from auto-registered MCP servers.
- **Quick / Deep mode** — keyword-based mode detection (`deep`, `thorough`, `comprehensive`, `lengkap`, `menyeluruh` trigger deep mode). Deep mode = up to 100 sources, 5 iterations. Quick mode = ~20 sources, 1-2 iterations.
- **Two-tier caching** — in-memory + persistent workspace cache for search results and read content. TTL configurable via `zai.research.cacheTTL`.
- **Retry with exponential backoff for rate limits** — automatic retry on Z.AI MCP -429 (`Rate limit reached`), with 1s/2s/4s backoff (max 2 retries per call).
- **Per-call timeout** — `withTimeout()` wrapper around `vscode.lm.invokeTool` (30s default). Failed calls return `[]` (search) or stub (read) so a hung query never blocks the whole run.
- **Junk URL filter** — `isJunkUrl()` drops obvious junk patterns (Instagram / TikTok / YouTube / Facebook, asset CDNs, "how to host" guides, regional selection pages) at the candidate stage. Saves up to 30s per junk URL.
- **URL dedup in candidates** — same URL across multiple queries is collapsed via `normalizeUrlForDedupe()` before `webRead` is called.
- **Top-K source cap for synthesis** — only the top 25 most-relevant sources are sent to the synthesis LLM, not all read sources. Bounded chunk count → bounded chunk-summary LLM calls.
- **Quality-first planning & expand prompts** — planner LLM is given criteria for "what makes a good query" (concrete entities, action-oriented, varied phrasings, 3-8 keyword sweet spot) and **gap-analysis context** (top-20 results from previous round) for expansion queries. Generic for all topics, not overfit to any domain.
- **Pure modules for unit testing** — 9 `vscode`-free modules: `mcpToolNameResolver`, `mcpResponseParser`, `mcpInputBuilders`, `mcpRateLimit`, `mcpTimeout`, `junkUrlFilter`, `ranker`, `budget`, `cache`.
- **75 unit tests** — covering BM25 ranking, budget guards, caching, fuzzy MCP tool name resolution, MCP envelope unwrapping, double-encoded JSON parsing, rate limit detection, per-call timeout, input field name contracts, URL dedup, and junk URL filtering.

### Settings
- `zai.research.maxSources` (default `100`) — max sources in deep mode
- `zai.research.maxIterations` (default `5`) — max query-expansion iterations
- `zai.research.concurrency` (default `3`) — parallel MCP calls (safe for rate limit)
- `zai.research.cacheTTL` (default `3600`) — search/read cache TTL in seconds
- `zai.research.synthesisModel` (default `glm-5.2`) — LLM for planning + synthesis
- `zai.research.webSearchToolName` (default `web_search_prime`) — override for VS Code MCP tool name format changes
- `zai.research.webReaderToolName` (default `webReader`) — override for VS Code MCP tool name format changes

### Fixed (during deep research development)
- **"search_query cannot be empty" (-400)** — was sending `{ query, count }` instead of `{ search_query, count }`. Extracted `buildWebSearchInput` / `buildWebReadInput` to a pure module with field-name contract tests.
- **Tool confirmation modal on every call** — was hard-coding `toolInvocationToken: undefined`. Now forwards `request.toolInvocationToken` from the chat request through the orchestrator to `McpToolInvoker`, so VS Code treats calls as user-authorized.
- **"0 URLs considered" despite successful MCP calls** — Z.AI MCP server double-encodes responses (text field value is a stringified JSON array). New `tryJsonParseDeep()` peels up to 3 layers of stringification.
- **Rate limit -429 with no recovery** — added `RateLimitError` detection (regex on `MCP error -429` / `Rate limit`) and exponential backoff in `McpToolInvoker.webSearch`. Also reduced default concurrency from 10 to 3.
- **"MCP not connected" with tools visible** — VS Code exposes MCP tools as `mcp_<server-truncated>_<toolname>` (e.g. `mcp_mcp-web-searc_web_search_prime`), not bare names. New fuzzy name resolver (3 strategies: exact → last-segment with snake/camel conversion → substring).
- **Participant disappeared from `@z` autocomplete** — VS Code chat picker matches on `name`, not `id`. Renamed `research` → `z-research` (kebab-case starting with `z`).
- **Dropdown noise from MCP definition provider** — registering `mcpServerDefinitionProviders` added 4 picker entries. Removed in favor of one-time `zai.setupMcp` command for a single clean `@z-research` entry.
- **"Stuck chat" on hung MCP call** — `vscode.lm.invokeTool` doesn't support `AbortSignal`, so wrapped each call in `withTimeout(thenable, 30s)`. Failed calls return `[]` so the orchestrator continues.
- **40+ LLM calls per research run** — chunk size 8K was too small (25 chunks for 100 sources). Increased to 16K (halves chunk count) and added a top-25 source cap for synthesis. ~60% fewer LLM calls per run.
- **Duplicate sources list in output** — the synthesis LLM already produces a `## Sources` section; the participant handler was appending a second `### Sources` list. Removed the duplicate.
- **Junk URLs wasting 30s timeouts** — Instagram / TikTok / YouTube / asset CDNs / "how to host" guides filtered at the candidate stage before `webRead` is called.

### Removed
- **`zai_webSearch` / `zai_webRead` Language Model Tools** — built in Phase 1, then deleted. The hybrid A+B (tools + participant) approach added picker noise for marginal benefit. Single chat participant UX is cleaner.
- **`zaiApiClient.ts`** — REST API client for Z.AI's `/api/paas/v4/tools/web_search` endpoint. The endpoint doesn't exist for Coding Plan users; we use MCP instead.

### Critical regression — extension would not load (fixed)
- **Extension crashed at activation: `MODULE_NOT_FOUND: p-limit`** — The deep research orchestrator imported `p-limit` from `node_modules`, but `vsce package` does not bundle `node_modules/`. When VS Code loaded the extension, `activate()` → `registerResearchFeatures()` → `require("p-limit")` threw, which took the entire extension host down — no Z.AI models appeared in the Language Models list and no model picker entries were registered.
  **Fix:** inlined a tiny concurrency limiter as `src/research/pLimit.ts` (~40 lines, no npm deps). Removed `p-limit` and `robots-parser` from `dependencies` so the extension is fully self-contained.
- **Model picker regression reverted** — During the deep research work, two non-API fields (`category`, `isUserSelectable`) were stripped from the model info object in `provideLanguageModelChatInformation`. Both are read by VS Code's `chatModelPicker.ts` (though they are not in the public `.d.ts`). Removing them caused the picker to silently switch back to the GitHub Copilot default model whenever the user selected a Z.AI model. Both fields are restored to match commit `ed26b28`.

### Performance (real user runs, 3 iterations)
- **Initial run:** 8 queries · 30 URLs · 11 sources · 1 iteration · 217s
- **Optimized run:** 15 queries · 129 URLs · 25 sources · 2 iterations · 250s (~10× more sources than the built-in Copilot web search)
- **Final (with all optimizations):** 13 queries · 110 URLs · 25 sources · 2 iterations · 214s

### Regressions fixed
- **Model picker regression — non-API fields stripped from `LanguageModelChatInformation`** — The previous build had two regressions from the working v0.2.5/ed26b28 baseline:
  1. **`category: "Z.AI"` and `isUserSelectable: true` were removed** — both are valid fields in VS Code's `LanguageModelChatInformation` (since 1.90). Removing them caused the chat model picker to silently switch back to the GitHub Copilot default model when the user picked a Z.AI model. Both fields are restored.
  2. **`isDefault: true` and a longer tooltip with `toLocaleString()` were added** — the `isDefault` flag and the formatted tooltip were assumed to be safe additions. Either change alone (or together) caused picker misbehaviour. Both are removed.
- **Lesson learned** — `LanguageModelChatInformation` accepts several non-obvious fields (`category`, `isUserSelectable`, `endpointKind`) that are not in the public `.d.ts` but ARE used by the chat model picker. Always test picker behaviour with the real VS Code build before removing or adding fields; the public API reference alone is not enough.

> **See [`doc/deep-research-journey.md`](./doc/deep-research-journey.md) for the full build log** — phases, rolled-back approaches, 25 production bugs with root-cause analysis, and lessons learned for future maintainers.

## 0.2.5 — 2026-06-24

### Fixed
- **Model picker crash on VS Code 1.126** (`a.charAt is not a function`) — the `provideLanguageModelChatInformation()` provider returned `category` as an object `{ label, order }`, but VS Code 1.126's `chatModelPicker.ts` sorts model entries by calling `a.charAt()` on the `category` value, expecting a **string**. Sending an object caused a `TypeError` every time the picker popup was opened, making the dropdown completely unresponsive. The `category` field is now a plain string (`"Z.AI"`).

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
