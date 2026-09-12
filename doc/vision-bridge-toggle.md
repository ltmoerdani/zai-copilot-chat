# Feature: Vision Bridge Toggle (`Z.AI: Toggle Vision Bridge`)

> **Status:** ✅ SHIPPED  
> **Date:** September 8, 2026  
> **Extension version:** 0.6.2  
> **Severity / Impact:** Medium — gives users one-command control over whether attached images are read by modlens  
> **Context:** Follow-up to the vision bridge shipped in 0.6.0 (`doc/modlens-vision-bridge-evaluation.md`). A user session surfaced the need to turn the bridge **off** just as easily as it was turned on — the only off-switch before this was hand-editing `zai.visionBridge.enabled` in Settings JSON.

---

## Table of Contents

1. [Summary](#1-summary)
2. [Problem](#2-problem)
3. [Solution](#3-solution)
4. [Code Changes](#4-code-changes)
5. [Verification](#5-verification)
6. [Related session context](#6-related-session-context)
7. [Sources](#7-sources)

---

## 1. Summary

A new command — **`Z.AI: Toggle Vision Bridge`** — flips the `zai.visionBridge.enabled` setting (Global target) in one step:

- **Toggle OFF**: attached/pasted images are no longer read by modlens. The "👁 Reading N attached image(s) via the modlens vision bridge — the first read can take 5–45s…" pre-pass disappears entirely; no more 5–45 s latency on image turns. **Native vision models (`glm-5.3-flash`, `glm-5v-turbo`, `glm-4.6v*`) are unaffected** — since 0.6.2 their images are forwarded inline to the multimodal endpoint and never go through the bridge. For text-only models, images are then stripped silently by `convertMessage()` (the pre-0.6.0 behavior).
- **Toggle ON**: image input is advertised to all GLM models again. Because the model picker's `imageInput` capability is queried once, the command offers a one-click **Reload Window** so the picker refreshes immediately.

The provider's model list is refreshed on both directions (`notifyModelsChanged()`), matching the existing `onDidChangeConfiguration` hook for `zai.visionBridge.enabled`.

---

## 2. Problem

The vision bridge shipped with two commands — **Setup** and **Status** — but no way to turn it off without opening Settings:

- `zai.visionBridge.enabled` could only be flipped by hand in `settings.json` or the Settings UI.
- Disabling matters in practice: the bridge adds 5–45 s of first-read latency per image (modlens subprocess), consumes the modlens engine's quota (Gemini key / agent CLI), and injects up to `maxEvidenceChars` (default 16 000) of text evidence per image into the conversation. Users on quota-sensitive setups or text-only workflows need a fast kill switch.
- Confusion vector observed in a live session: a user unchecked models in VS Code's model picker and expected image processing to stop. The model picker and the vision bridge are independent — the picker controls which models are *listed*, the bridge controls whether *images are read at request time*. Without an explicit, discoverable "off" command, the only visible symptom of the bridge running is the announce note, and the only off-switch is a buried setting.

---

## 3. Solution

### Command semantics

| Action | What happens |
|---|---|
| Run `Z.AI: Toggle Vision Bridge` while enabled | `zai.visionBridge.enabled` → `false` (Global). Models refreshed. Toast: "Vision bridge DISABLED — attached images are no longer read (no more '👁 Reading N attached image(s)…'). Takes effect on the next request." |
| Run it while disabled | `zai.visionBridge.enabled` → `true` (Global). Models refreshed. Toast with **Reload Window** action so the picker re-queries `imageInput` capabilities. |

Design rules:

- **One setting, one owner.** The command only flips `zai.visionBridge.enabled`; it does not touch `bin`, `provider`, cache, or any other `zai.visionBridge.*` value. Engine state, evidence cache, and auto-provision grants all survive a toggle — re-enabling picks up exactly where things left off (cache hits included).
- **Off takes effect on the next request**, not mid-request: the pre-pass runs at the top of `provideLanguageModelResponse` and re-reads the setting each time (`isVisionBridgeEnabled()`), so no reload is needed for disabling.
- **Enable may need a reload**: when the bridge is on, every model advertises `imageInput`/`supportsImageToText`. VS Code caches the advertised capabilities until the provider fires a change event — hence the optional Reload Window prompt (same pattern as the Setup command).

### Relationship to the rest of the bridge

- `zai.visionBridge.announce: false` silences only the "👁 Reading…" note but keeps reading images. The toggle stops the *processing itself*.
- The evidence cache (memory LRU + persistent sidecars) is untouched by the toggle; stats and entries persist.

---

## 4. Code Changes

| File | Change |
|---|---|
| `src/vision/visionBridge.ts` | New exported `toggleVisionBridge(notifyModelsChanged)` — reads current state via `getVisionBridgeSettings().enabled`, flips the setting (Global), notifies models, shows the state-appropriate toast (Reload Window action only on enable). |
| `src/extension.ts` | Import `toggleVisionBridge`; register `zai.vision.toggle` wired to `provider.refreshModels()`. |
| `package.json` | Command contribution `zai.vision.toggle` → "Z.AI: Toggle Vision Bridge". |
| `README.md` | Vision Bridge section (feature, setup, toggle, settings table) + commands rows. |
| `CHANGELOG.md` | Entry under 0.6.1 (Added). |

---

## 5. Verification

- `tsc -p ./` — clean (0 errors).
- `git diff` — purely additive (+43/−0 across 3 files), no behavior change to existing code paths.
- Manual check list for the next live session:
  1. With the bridge enabled, run the toggle → confirm toast says DISABLED and the next image-bearing turn shows **no** "👁 Reading…" note and no modlens latency.
  2. Run the toggle again → confirm ENABLED toast + Reload Window action; after reload the picker still offers paste/attach.
  3. Confirm the evidence cache survives a toggle cycle (Status command shows the same persistent entries after re-enable).
  4. Confirm engine configuration (`reuse.*` grants, provider pin) is unchanged after toggling.

---

## 6. Related session context

**Native vision pass-through (0.6.2).** While verifying this toggle live, the user found that `glm-5.3-flash` answered "I don't see any image" on an attached image. The dev-host log showed a successful request with no bridge pre-pass and no error — the image had been stripped by `convertMessage()`'s blanket `image_url` removal (a glm-4.6v-era leftover) despite the model's advertised `imageInput` capability. Fixed in the same release: native vision models now forward `image_url` parts inline (bridge skipped), with a one-shot strip-and-retry safety net if the endpoint rejects them. See the CHANGELOG 0.6.2 entry.

This feature closes the loop on a session where the initial request ("can we turn models off via UI/command?") was first misread as *model-picker visibility management*. That implementation (a `Z.AI: Manage Models` multi-select picker backed by a `zai.disabledModels` setting) was **fully reverted** before shipping — the diff was audited against HEAD and an unrelated regression it had introduced in `fetchModels()` (loss of the `!response.ok` 401/403 → bundled-fallback branch) was caught and restored in the same pass. Nothing from that attempt remains in the tree.

Lesson recorded for future sessions: when a request like "turn off X" is ambiguous and another feature is actively producing visible symptoms, confirm the target before implementing.

---

## 7. Sources

- Vision bridge architecture + capability advertisement: [`doc/modlens-vision-bridge-evaluation.md`](./doc/modlens-vision-bridge-evaluation.md).
- Existing enable path: `runVisionSetup` in `src/vision/visionBridge.ts` (same `notifyModelsChanged` + Reload Window pattern).
- VS Code `LanguageModelChatProvider` — advertised capabilities are re-queried when the provider fires its change event (`provider.refreshModels()`).
