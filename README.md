# Z.AI for GitHub Copilot Chat

> **Use [Z.AI](https://z.ai) GLM models directly in GitHub Copilot Chat — no Copilot Pro/Enterprise subscription needed. Just bring your own API key (BYOK).**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.120%2B-blue)](https://code.visualstudio.com/)
[![Z.AI](https://img.shields.io/badge/Z.AI-GLM-4f46e5)](https://z.ai)

---

## What Is This?

**Z.AI for GitHub Copilot Chat** is a VS Code extension that registers [Z.AI](https://z.ai) GLM series models — including **GLM-4.7**, **GLM-5**, **GLM-5.1**, and **GLM-4.5** — into **GitHub Copilot Chat** via the official VS Code *Language Model Chat Provider API*.

This lets you pick and use Z.AI GLM models directly from the Copilot Chat model picker, just like selecting GPT-4 or Claude — no extra Copilot Pro/Enterprise subscription required. Simply enter your Z.AI API key.

| Model | Context | Max Output | Vision | Description |
|---|---:|---:|:---:|---|
| **GLM-5.1** | 200K | 128K | ❌ | Latest flagship, optimized for long-horizon tasks |
| **GLM-5** | 200K | 128K | ❌ | Next-generation GLM, agentic planning |
| **GLM-5-Turbo** | 200K | 128K | ❌ | Enhanced GLM-5 for complex long tasks |
| **GLM-4.7** | 200K | 128K | ❌ | High-intelligence model, strong coding |
| **GLM-4.6** | 200K | 128K | ❌ | High-performance, 200K context upgrade |
| **GLM-4.5** | 128K | 96K | ❌ | Balanced performance and cost |
| **GLM-4.5-Air** | 128K | 96K | ❌ | High cost-performance ratio |
| **GLM-4.5-AirX** | 128K | 96K | ❌ | High-speed variant of GLM-4.5-Air |
| **GLM-4.5-Flash** | 128K | 96K | ❌ | Free, fastest GLM text model |
| **GLM-5V-Turbo** | 200K | 128K | ✅ | Multimodal vision + coding base model |
| **GLM-4.6V** | 128K | 32K | ✅ | Visual reasoning with tool calling |
| **GLM-4.6V-Flash** | 128K | 32K | ✅ | Free vision model with tool calling |

---

## ✨ Features

- **BYOK** — configure your Z.AI API key once, all models are available
- **Live model list** — fetches available models from Z.AI API on every startup
- **Bundled fallback** — works offline or if the API is unreachable, using a curated model table with accurate token limits
- **Per-model token limits** — precise context window and max output token values per model, not a single global cap
- **Tool-calling support** — forwards tool schemas using OpenAI-compatible chat completions
- **Reasoning debug** — opt-in `reasoning_content` logging to the Z.AI output channel
- **Diagnostics command** — one-click markdown report showing exactly which models VS Code has registered

---

## Requirements

- VS Code **1.120.0** or higher with the Language Model Chat Provider API
- **GitHub Copilot Chat** extension — [install from marketplace](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) (required — this extension only adds models *into* Copilot Chat)
- Sign in to GitHub Copilot Chat (a personal GitHub account is sufficient — **no** Copilot Pro/Enterprise needed for BYOK)
- A **Z.AI API key** — get one at [z.ai](https://z.ai)

---

## ⚡ Quick Start

1. Install **GitHub Copilot Chat** from the marketplace if you haven't already.
2. Install this extension (or press `F5` in the repo to launch an Extension Development Host).
3. Open **GitHub Copilot Chat** (click the Copilot icon in the sidebar or press `Cmd+Shift+I` / `Ctrl+Shift+I`).
4. Click the **model picker** (current model name) → **Manage Models…**
5. Select **Z.AI**.
6. Press `Enter` to accept the default **Group Name**.
7. Enter your Z.AI **API Key** when prompted — VS Code stores it securely as a secret.
8. Choose the models you want available.
9. Select any Z.AI model from the picker and start chatting.

> **💡 Tips:**
> - Registered models are automatically available in the Copilot Chat model picker — no extra setup needed.
> - If a model appears in the **Language Models** view but not in the chat picker, hover its row and click the eye icon (👁) to enable visibility.

---

## Commands

Once installed, Z.AI models appear directly in the **GitHub Copilot Chat model picker** — no special commands needed. The easiest way to manage your API key is via **Settings → Language Models** (gear icon ⚙).

For advanced usage, you can also run these commands via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Z.AI: Manage Provider` | Manage API key, refresh models, or test connection |
| `Z.AI: Set API Key` | Store or update your Z.AI API key |
| `Z.AI: Diagnostics` | Show a markdown report of all registered Z.AI models |

> **Note:** The native BYOK flow via **Language Models** (gear icon ⚙) is recommended.

---

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `zai.temperature` | `number` | `0.2` | Sampling temperature for chat completions (`0`–`2`) |
| `zai.maxTokens` | `number` | `0` | Max output token override — `0` uses the per-model bundled maximum |
| `zai.maxInputTokens` | `number` | `0` | Context window override — `0` uses the per-model bundled context size |
| `zai.debugReasoning` | `boolean` | `false` | Write provider `reasoning_content` to **Output → Z.AI** for debugging |

---

## Models

The extension fetches the live model list from:

```
https://api.z.ai/api/coding/paas/v4/models
```

Because the Z.AI API returns model IDs only, a bundled metadata table provides context window and max output tokens per model. If the live fetch fails, the bundled list is used as a fallback.

VS Code and Copilot read separate input/output metadata fields for UI display. GLM models can have very large output limits, so the extension advertises a small response reserve to keep the **Language Models** table, model picker tooltip, and chat context indicator consistent while still sending each model's full bundled max output limit to the Z.AI API.

### Bundled model limits

| Model | Context window | Max output tokens | Vision |
|---|---:|---:|:---:|
| `glm-4.7` | 200K (204,800) | 128K (131,072) | ❌ |
| `glm-5` | 200K (204,800) | 128K (131,072) | ❌ |
| `glm-5.1` | 200K (204,800) | 128K (131,072) | ❌ |
| `glm-4.5-air` | 128K (131,072) | 96K (98,304) | ❌ |
| `glm-4.5-flash` | 128K (131,072) | 96K (98,304) | ❌ |
| `glm-5v-turbo` | 200K (204,800) | 128K (131,072) | ✅ |
| `glm-4.6v` | 128K (131,072) | 32K (32,768) | ✅ |
| `glm-4.6v-flash` | 128K (131,072) | 32K (32,768) | ✅ |

Set `zai.maxInputTokens` or `zai.maxTokens` to a non-zero value to override the bundled defaults globally.

All models use the OpenAI-compatible chat completions endpoint:

```
https://api.z.ai/api/coding/paas/v4/chat/completions
```

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch
```

Press `F5` in VS Code to launch an **Extension Development Host** with the extension loaded.

To package a `.vsix` for local install:

```bash
npm run package
```

---

## Contributing

Issues and pull requests are welcome. Please open an issue first for significant changes so we can discuss the approach.

---

## License

MIT — see [LICENSE](./LICENSE) for details.
