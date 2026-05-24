# Changelog

All notable changes to the **Z.AI Copilot Chat** extension are documented here.

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
