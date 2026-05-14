# Changelog

All notable changes to the **Z.AI Copilot Chat** extension are documented here.

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
