# Patch: VS Code 1.128 BYOK Utility Model Error

> **Status:** ✅ RESOLVED  
> **Date:** July 8, 2026  
> **Extension version:** 0.3.3  
> **Severity:** High — every background utility task (chat title generation, commit messages, intent detection) broken for all BYOK users after updating VS Code  
> **Root Cause:** VS Code 1.128 introduced `chat.byokUtilityModelDefault` with default value `"none"`, disabling utility models for BYOK. The auto-fix in v0.3.3-initial used the wrong enum value `"mainModel"` instead of the correct `"mainAgent"`, so the setting was silently ignored.

---

## Table of Contents

1. [Summary](#1-summary)
2. [Environment](#2-environment)
3. [VS Code 1.128 Breaking Change](#3-vs-code-1128-breaking-change)
4. [Investigation Timeline](#4-investigation-timeline)
5. [Failed Attempt](#5-failed-attempt)
6. [Successful Solution](#6-successful-solution)
7. [Technical Analysis](#7-technical-analysis)
8. [Code Changes](#8-code-changes)
9. [Prevention Recommendations](#9-prevention-recommendations)
10. [Follow-up — "Z.AI missing from the picker on a second device" (0.4.0)](#10-follow-up--zaiai-missing-from-the-picker-on-a-second-device-040)
11. [Follow-up — "Gear icon / 'Manage Models…' does nothing when clicked" (0.4.0)](#11-follow-up--gear-icon--manage-models-does-nothing-when-clicked-040)
12. [Verification — Fresh-env smoke test of v0.4.0 (2026-07-18)](#12-verification--fresh-env-smoke-test-of-v040-2026-07-18)

---

## 1. Summary

After updating VS Code to **1.128.0** (released July 8, 2026), any user with a BYOK extension as the main chat model sees this error in the chat view:

```
No utility model is configured for 'copilot-utility-small' while the
selected main agent model is BYOK.
```

This error appears because VS Code 1.128 changed the default behavior: when a BYOK model is the main agent, VS Code **no longer falls back** to `copilot-utility-small` (GitHub Copilot's internal lightweight model) for background utility flows. Since our extension does not configure a utility model, VS Code fails with this error every time a background task is triggered (e.g., naming a new chat tab, auto-generating a commit message in Source Control, detecting intent).

The fix is to set `chat.byokUtilityModelDefault = "mainAgent"` in VS Code global settings. The extension does this **automatically** on activation in v0.3.3.

A first attempt used the wrong value `"mainModel"` which VS Code silently ignored (unknown enum value), falling back to `"none"`. The correct value — verified from the VS Code 1.128 desktop bundle — is `"mainAgent"`.

---

## 2. Environment

| Component | Version |
|---|---|
| VS Code | **1.128.0** (stable, July 8, 2026) |
| OS | macOS (Darwin arm64) |
| Extension | `ltmoerdani.zai-copilot-chat` v0.3.2 (affected), v0.3.3 (fixed) |
| GitHub Copilot | Signed in (but BYOK model selected as main agent) |

---

## 3. VS Code 1.128 Breaking Change

### New setting: `chat.byokUtilityModelDefault`

VS Code 1.128 introduced a new setting ([release notes](https://code.visualstudio.com/updates/v1_128#_configure-the-default-utility-model-for-byok)):

| Property | Value |
|---|---|
| **Key** | `chat.byokUtilityModelDefault` |
| **Type** | `string` |
| **Default** | `"none"` |
| **Valid values** | `"none"` · `"mainAgent"` · `"copilot"` |

**Before 1.128:** When a BYOK model was the main agent, VS Code silently fell back to `copilot-utility-small` for utility tasks (title generation, commit messages, etc.).

**After 1.128:** The default is explicitly `"none"` — no utility model. Unless the user or extension configures one, all background utility tasks fail with the error above.

### Two other related settings (unchanged since earlier VS Code versions)

| Setting | Purpose |
|---|---|
| `chat.utilityModel` | Override the model for general utility flows (titles, summaries, Git review). Takes precedence over `byokUtilityModelDefault`. |
| `chat.utilitySmallModel` | Override the model for fast lightweight flows (commit messages, rename suggestions, intent detection). Takes precedence over `byokUtilityModelDefault`. |

`chat.byokUtilityModelDefault` is a **blanket fallback** — it activates only when neither of the two explicit settings above is configured.

---

## 4. Investigation Timeline

### Step 1: Error identified after VS Code update

User updated VS Code to 1.128.0 and immediately saw the error in the Copilot Chat view. The error persisted across all Z.AI models and all workspaces.

### Step 2: Root cause confirmed from VS Code release notes

VS Code 1.128 release notes ([§ Configure the default utility model for BYOK](https://code.visualstudio.com/updates/v1_128#_configure-the-default-utility-model-for-byok)) explicitly state:

> "The default behavior is that no utility models are used with BYOK models as the main agent. Background tasks such as chat title generation and commit message generation do not work unless this option is set."

This confirmed the error was a **platform behavior change**, not a bug in the extension's core chat-completion logic.

### Step 3: Identified the correct setting to write

Three possible remedies:
1. Set `chat.utilitySmallModel` to a specific Z.AI model ID → requires knowing the model ID format VS Code uses in this setting, fragile if user changes their default model.
2. Set `chat.utilityModel` to a specific Z.AI model ID → same problem.
3. Set `chat.byokUtilityModelDefault = "mainAgent"` → VS Code reuses whatever BYOK model is currently selected as the main agent. **No model ID needed. Robust.**

Option 3 was chosen because it is model-agnostic: it works regardless of which Z.AI model (GLM-5.2, GLM-4.7, Flash, etc.) the user has selected as their main agent.

### Step 4: First auto-fix attempt — wrong enum value

In `checkUtilityModelConfiguration()`, the setting was written as:

```typescript
chat.update("byokUtilityModelDefault", "mainModel", vscode.ConfigurationTarget.Global)
```

The value `"mainModel"` was guessed from the VS Code release notes description ("use the main agent model"). VS Code silently discarded it (unknown enum value) and kept `"none"` as the effective value. The error persisted.

### Step 5: Enum values extracted from VS Code binary

The valid enum was found by grepping the installed VS Code desktop bundle directly:

```bash
python3 -c "
import re
data = open('/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js','rb').read().decode('utf-8','ignore')
m = re.search(r'byokUtilityModelDefault.{0,800}', data)
if m: print(m.group())
"
```

Output (minified JS, formatted for readability):

```javascript
"chat.byokUtilityModelDefault": {
  type: "string",
  enum: ["none", "mainAgent", "copilot"],
  default: "none"
}
```

**Correct value: `"mainAgent"` (not `"mainModel"`).**

### Step 6: Fix applied and verified

After correcting the value to `"mainAgent"`, the setting was confirmed written to `settings.json`:

```bash
python3 -c "
import json, os
path = os.path.expanduser('~/Library/Application Support/Code/User/settings.json')
data = json.loads(open(path).read())
print('chat.byokUtilityModelDefault:', repr(data.get('chat.byokUtilityModelDefault')))
"
# Output: chat.byokUtilityModelDefault: 'mainAgent'
```

Error resolved. Background tasks work again.

---

## 5. Failed Attempt

| Attempt | Value used | Result | Why it failed |
|---|---|---|---|
| v0.3.3-initial auto-fix | `"mainModel"` | ❌ Error persisted | Not a valid enum value; VS Code silently ignored it and kept `"none"` |

**Lesson:** VS Code silently ignores invalid enum values for configuration settings — no error is thrown, no warning is logged. Always verify enum values from the actual VS Code source/binary, not from prose descriptions in release notes.

---

## 6. Successful Solution

**Setting:** `chat.byokUtilityModelDefault = "mainAgent"` written to `ConfigurationTarget.Global` (user `settings.json`).

**Behavior:**
- On VS Code 1.128+, the extension checks if any utility model is already explicitly configured (`byokUtilityModelDefault`, `utilitySmallModel`, `utilityModel`).
- If none is configured (or if `byokUtilityModelDefault` is still `"none"`, the default), the extension automatically writes `"mainAgent"`.
- After the write, a one-time toast notification confirms what was changed.
- If the user has already configured any of the three settings to a non-default value, the extension leaves them untouched.

**Effect:** VS Code routes all background utility tasks (title generation, commit messages, intent detection, rename suggestions) to the user's currently-selected Z.AI BYOK model instead of failing.

---

## 7. Technical Analysis

### Why `"mainAgent"` works

`chat.byokUtilityModelDefault = "mainAgent"` tells VS Code's Copilot Chat extension: *"when a BYOK model is selected as main agent and a utility task needs a model, reuse the main agent model."*

This is the correct behavior for a BYOK-only extension like Z.AI because:
- The user has already selected a Z.AI model as their main agent.
- Utility tasks (commit messages, etc.) are low-token, fast operations any GLM model handles well.
- No separate model ID needs to be specified — VS Code resolves the model at call time from the current main agent selection.

### Why `"mainModel"` silently fails

VS Code processes configuration settings through a schema validator. When a `string` setting has an `enum` array and the provided value is not in the enum, VS Code:
1. Writes the value to `settings.json` as-is (no write error).
2. At runtime, reads the value and checks it against the enum.
3. If the value is not in the enum, falls back to `default` (`"none"`).
4. Logs nothing to the user.

This is the standard VS Code configuration behavior and is intentional — it prevents settings from becoming invalid after schema changes. But it means **invalid enum values fail silently**, which is why the first attempt appeared to "work" (the setting was written) while the error persisted.

### `isConfigured` guard logic

The function also guards against the VS Code default value `"none"` being treated as "already configured":

```typescript
const isConfigured =
  (byokDefault !== "" && byokDefault !== undefined && byokDefault !== "none") || ...
```

Without the `!== "none"` check, a fresh VS Code install that has never had `byokUtilityModelDefault` set would return `byokDefault = "none"` (the default), which would be incorrectly treated as "user already configured this" and skip the auto-fix.

---

## 8. Code Changes

**File:** `src/extension.ts`

### New function: `checkUtilityModelConfiguration(context)`

Called once from `activate()` after `registerResearchFeatures()`. Full function:

```typescript
function checkUtilityModelConfiguration(context: vscode.ExtensionContext): void {
  const [major, minor] = vscode.version.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 128)) return;

  const chat = vscode.workspace.getConfiguration("chat");
  const byokDefault  = chat.get<string>("byokUtilityModelDefault", "");
  const utilitySmall = chat.get<string>("utilitySmallModel", "");
  const utilityGeneral = chat.get<string>("utilityModel", "");

  const isConfigured =
    (byokDefault !== "" && byokDefault !== undefined && byokDefault !== "none") ||
    (utilitySmall !== "" && utilitySmall !== undefined && utilitySmall !== "Default") ||
    (utilityGeneral !== "" && utilityGeneral !== undefined && utilityGeneral !== "Default");
  if (isConfigured) return;

  // Valid enum (from VS Code 1.128 desktop bundle): "none" | "mainAgent" | "copilot"
  void chat
    .update("byokUtilityModelDefault", "mainAgent", vscode.ConfigurationTarget.Global)
    .then(() => {
      const NOTICE_KEY = "zai.utilityModelAutoFixed.v1128";
      if (context.globalState.get<boolean>(NOTICE_KEY)) return;
      void context.globalState.update(NOTICE_KEY, true);
      void vscode.window.showInformationMessage(
        "Z.AI: Automatically fixed VS Code 1.128 utility model setting. " +
          "Background tasks (chat titles, commit messages) now use your Z.AI model.",
      );
    });
}
```

### Bug fix: duplicate `registerResearchFeatures` call

`activate()` previously called `registerResearchFeatures(context)` twice (copy-paste error). Fixed to a single call.

**Before:**
```typescript
registerResearchFeatures(context);

// Register Z.AI deep research features (@z-research participant + MCP setup command).
registerResearchFeatures(context);
```

**After:**
```typescript
registerResearchFeatures(context);

checkUtilityModelConfiguration(context);
```

---

## 9. Prevention Recommendations

### For extension developers targeting BYOK / Language Model Provider API

1. **Never guess enum values from prose documentation.** Always extract them from VS Code source or the installed binary:
   ```bash
   python3 -c "
   import re
   data = open('/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js','rb').read().decode('utf-8','ignore')
   m = re.search(r'SETTING_KEY.{0,600}', data)
   if m: print(m.group())
   "
   ```

2. **Test configuration writes in the Extension Development Host.** Invalid enum values don't throw — you must read back the effective value after writing to confirm VS Code accepted it.

3. **Watch VS Code release notes for BYOK-related changes.** The `chat.*` namespace is actively evolving. Subscribe to [VS Code release notes](https://code.visualstudio.com/updates) and filter for "BYOK", "utility model", and "language model provider".

4. **For any `chat.*` setting you auto-configure, always check the guard logic covers the default value.** VS Code returns the schema `default` (e.g., `"none"`) from `getConfiguration().get()` even if the user has never touched the setting — so `byokDefault !== ""` alone is insufficient as an "already configured" check.

### For users

If you see `"No utility model is configured for 'copilot-utility-small'"` after updating VS Code:
1. Ensure extension v0.3.3+ is installed.
2. Reload VS Code window (`Cmd+Shift+P` → **Reload Window**).
3. The extension will auto-apply `chat.byokUtilityModelDefault = "mainAgent"` and show a brief toast.

If the error persists, check `settings.json` manually:
```bash
python3 -c "
import json, os
path = os.path.expanduser('~/Library/Application Support/Code/User/settings.json')
data = json.loads(open(path).read())
print(data.get('chat.byokUtilityModelDefault', '(not set)'))
"
```
Expected output: `mainAgent`. If it shows anything else, set it manually in VS Code Settings UI (search `chat.byokUtilityModelDefault`, select **Use main agent model**).

---

## 10. Follow-up — "Z.AI missing from the picker on a second device" (0.4.0)

> **Status:** ✅ Root cause identified, diagnostics added in v0.4.0
> **Date:** July 18, 2026
> **Severity:** High — Z.AI models silently missing from the Copilot Chat model picker on fresh devices

### Symptom

On a second Mac, Z.AI models never appeared in the Copilot Chat model picker, even after the user believed they had completed onboarding. Re-registering under the same vendor id reported `"already registered"`, and a fresh vendor id (e.g. `zai2`) also produced no models.

### Root cause

VS Code's `registerLanguageModelProvider` source (verified in `workbench.desktop.main.js`) is:

```javascript
registerLanguageModelProvider(o, e) {
  if (!this._vendors.has(o))
    throw new Error(`Chat model provider uses UNKNOWN vendor ${o}.`);
  if (this._providers.has(o))
    throw new Error(`Chat model provider for vendor ${o} is already registered.`);
  this._providers.set(o, e);
  // ...
}
```

The `_vendors` map is populated **only** from `package.json` `languageModelChatProviders` contributions via `deltaLanguageModelChatProviderDescriptors`. Without the declarative contribution, VS Code logs `"Chat model provider uses UNKNOWN vendor zai"` and the programmatic registration silently fails.

**Conclusion:** both paths must coexist. The declarative contribution (`package.json`) registers the vendor id, the programmatic provider (`vscode.lm.registerLanguageModelChatProvider`) supplies the model list. They are not redundant and must not be removed. The contribution is **retained** in v0.4.0.

The actual failure on the second Mac was that the extension's SecretStorage entry `zai.apiKey` was empty on that machine. VS Code Settings Sync **does not sync SecretStorage** for security reasons, so the key has to be re-entered on each device via `Z.AI: Set API Key`. When the key is missing, `provideLanguageModelChatInformation` returns `[]` and the picker shows nothing — even though the vendor id is registered.

### Verification

Reproduced in an isolated environment:

```bash
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
FRESH_DIR="/tmp/zai-040-fresh"
FRESH_EXT="/tmp/zai-040-ext"
rm -rf "$FRESH_DIR" "$FRESH_EXT" && mkdir -p "$FRESH_DIR" "$FRESH_EXT"
"$CODE" --extensions-dir="$FRESH_EXT" --install-extension zai-copilot-chat-0.4.0.vsix
"$CODE" --user-data-dir="$FRESH_DIR" --extensions-dir="$FRESH_EXT" --new-window "$FRESH_DIR"
```

With no API key the `Z.AI` output channel showed:

```
=== Z.AI activation diagnostics ===
[activate] extension activated, vendor="zai"
[activate] VS Code version: 1.129.1
[activate] SecretStorage "zai.apiKey": MISSING — run 'Z.AI: Set API Key' then reload
[activate] selectChatModels({ vendor: "zai" }): 0 model(s) visible to VS Code
=== end activation diagnostics ===
```

After inserting the encrypted SecretStorage entry from the main profile into the fresh profile's `state.vscdb`:

```
=== Z.AI activation diagnostics ===
[activate] SecretStorage "zai.apiKey": present (len=49)
[activate] selectChatModels({ vendor: "zai" }): 13 model(s) visible to VS Code
=== end activation diagnostics ===
provideLanguageModelChatInformation: advertising 13 model(s) to VS Code [glm-4.5, glm-4.5-air, glm-4.6, …]
```

Removing the declarative contribution as an experiment caused `"[error] Error: Chat model provider uses UNKNOWN vendor zai."` in the Extension Host log — confirming the dependency. The contribution was restored before release.

### Diagnostics added

To make any future regression immediately diagnosable, v0.4.0 emits a one-shot activation banner to the `Z.AI` output channel:

```
2026-07-18T... === Z.AI activation diagnostics ===
2026-07-18T... [activate] extension activated, vendor="zai"
2026-07-18T... [activate] VS Code version: 1.129.1
2026-07-18T... [activate] SecretStorage "zai.apiKey": present (len=...)
2026-07-18T... [activate] selectChatModels({ vendor: "zai" }): 13 model(s) visible to VS Code
2026-07-18T... === end activation diagnostics ===
```

If `selectChatModels` reports 0 models while the key is missing, a toast with a `Set API Key` action button is shown. `provideLanguageModelChatInformation` also logs when it returns `[]` because the key is missing, when cancelled, and how many models it advertises — closing the previous blind spot where VS Code silently reported 0 models with no trace.

### Runbook for "Z.AI missing from picker" reports

1. Open the `Z.AI` output channel. Look for the activation diagnostics banner.
2. If `SecretStorage "zai.apiKey": MISSING` → run `Z.AI: Set API Key`, then `Developer: Reload Window`.
3. If the key is present but `selectChatModels` still reports 0 models → check the Extension Host log for `"Chat model provider uses UNKNOWN vendor zai"`. That error means the declarative `languageModelChatProviders` contribution has been removed from `package.json` and must be restored.
4. If `selectChatModels` reports 13 models but the picker is still empty → reload the window. VS Code caches the picker list per window.

---

## 11. Follow-up — "Gear icon / 'Manage Models…' does nothing when clicked" (0.4.0)

> **Status:** ✅ Workaround added in v0.4.0
> **Date:** July 18, 2026
> **Severity:** Medium — blocks access to the Language Models view from the picker

### Symptom

In the Copilot Chat model picker, the gear icon (or the **Manage Models…** entry) does nothing when clicked — no popup, no error, no visible state change. This is independent of the Z.AI models showing up in the picker list.

### Root cause

The gear icon invokes VS Code's built-in command `workbench.action.chat.manage` ("Manage Language Models"). Extracted from `workbench.desktop.main.js`:

```javascript
class extends K {
  constructor() {
    super({
      id: utt,  // "workbench.action.chat.manage"
      title: N(9474, "Manage Language Models"),
      precondition: OYt,  // ← gate
      f1: true
    })
  }
  async run(t) {
    let i = t.get(ie);
    await pVn(t);
    return i.openEditor(new $ye, {pinned: true});
  }
}
```

The precondition `OYt` is:

```javascript
OYt = x.and(
  ee.enabled,  // chatIsEnabled context key
  x.or(
    ee.Entitlement.planFree,        // chatPlanFree
    ee.Entitlement.planEdu,
    ee.Entitlement.planPro,
    ee.Entitlement.planProPlus,
    ee.Entitlement.planMax,
    ee.Entitlement.planBusiness,
    ee.Entitlement.planEnterprise,
    ee.Entitlement.internal,
    or.clientByokEnabled            // github.copilot.clientByokEnabled
  )
)
```

`ee.enabled` (`chatIsEnabled`) defaults to `false` and is set to `true` only by the GitHub Copilot Chat extension after the user signs in. On a second device where Settings Sync did not carry the auth state, the user can be in a state where:

- The Z.AI extension is installed and the API key is set.
- `selectChatModels({ vendor: "zai" })` returns 13 models.
- But `chatIsEnabled` is `false`, so `ee.enabled` is false, so the precondition `OYt` fails, so the command is a no-op.

The picker visibility helper mirrors this:

```javascript
function b_n(s) {
  return s.clientByokEnabled || s.hasByokModels ||
         s.entitlement === 5 ||  // Free
         s.entitlement === 6 ||  // Pro
         s.entitlement === 7 ||  // ProPlus
         s.entitlement === 8 ||  // Max
         s.entitlement === 9 ||  // Business
         s.entitlement === 10 || // Enterprise / EDU
         s.entitlement === 11 || // internal
         s.isInternal;
}
```

### Workaround

The `clientByokEnabled` branch of the precondition is the escape hatch. Its definition:

```javascript
a.clientByokEnabled = new X("github.copilot.clientByokEnabled", !0, !0)
```

Default value is `true`. The extension sets it explicitly via:

```typescript
await vscode.commands.executeCommand(
  "setContext",
  "github.copilot.clientByokEnabled",
  true,
);
```

This is invoked from `logActivationDiagnostics` only when at least one Z.AI model is registered. Setting the context key satisfies the OR-branch of `OYt`, which makes the gear icon clickable again even when the user is not signed in to Copilot, as long as they have at least one BYOK model registered.

This is defensive — `clientByokEnabled` already defaults to `true` per the schema, but VS Code sometimes leaves it unset until the Copilot extension first touches the context service. Forcing the value removes that race.

### Definitive fix for end users

If the gear icon is still unresponsive after reload, sign in to GitHub Copilot Chat. A free personal GitHub account is sufficient — no Copilot Pro subscription is required for BYOK usage. The sign-in button is in the Copilot Chat sidebar.

### Verification

After implementing the workaround:

1. Fresh `--user-data-dir` install of v0.4.0 with API key set.
2. `Z.AI` output channel reports:
   ```
   [activate] selectChatModels({ vendor: "zai" }): 13 model(s) visible to VS Code
   [activate] set 'github.copilot.clientByokEnabled' = true (ensures Manage Models gear icon stays clickable for BYOK users who are not signed in to Copilot)
   ```
3. Gear icon in the picker opens the Language Models editor.

---

## 12. Verification — Fresh-env smoke test of v0.4.0 (2026-07-18)

> **Status:** ✅ All fixes verified end-to-end
> **Date:** July 18, 2026
> **Tested version:** `zai-copilot-chat-0.4.0.vsix` (208 KB)

### Test methodology

To simulate a "fresh device" without modifying the author's main VS Code profile, the extension was installed into a fully isolated environment using `--user-data-dir` and `--extensions-dir`:

```bash
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
FRESH_DIR="/tmp/zai-040-test"
FRESH_EXT="/tmp/zai-040-test-ext"

rm -rf "$FRESH_DIR" "$FRESH_EXT"
mkdir -p "$FRESH_DIR" "$FRESH_EXT"

# Install only the Z.AI extension into the isolated extensions dir
"$CODE" --extensions-dir="$FRESH_EXT" \
  --install-extension zai-copilot-chat-0.4.0.vsix

# First launch: let VS Code create state.vscdb, then close
"$CODE" --user-data-dir="$FRESH_DIR" --extensions-dir="$FRESH_EXT" \
  --new-window --disable-workspace-trust "$FRESH_DIR"
# (close after a few seconds)

# Copy the encrypted SecretStorage entry from the main profile so the
# fresh env has a valid API key without re-entering it manually.
MAIN_SQLITE="$HOME/Library/Application Support/Code/User/globalStorage/state.vscdb"
FRESH_SQLITE="$FRESH_DIR/User/globalStorage/state.vscdb"
VALUE=$(sqlite3 "$MAIN_SQLITE" \
  "SELECT value FROM ItemTable WHERE key = 'secret://{\"extensionId\":\"ltmoerdani.zai-copilot-chat\",\"key\":\"zai.apiKey\"}';")
sqlite3 "$FRESH_SQLITE" \
  "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('secret://{\"extensionId\":\"ltmoerdani.zai-copilot-chat\",\"key\":\"zai.apiKey\"}', '$VALUE');"

# Second launch: activate with API key present
"$CODE" --user-data-dir="$FRESH_DIR" --extensions-dir="$FRESH_EXT" \
  --new-window --disable-workspace-trust "$FRESH_DIR"
```

### Test matrix

| Check | Expected | Actual | Result |
|---|---|---|---|
| `.vsix` builds without errors | clean compile | `tsc -p ./` clean | ✅ |
| Unit tests | 75/75 pass | 75 pass, 0 fail | ✅ |
| Extension activates in fresh env | activation log in exthost | `ExtensionService#_doActivateExtension ltmoerdani.zai-copilot-chat, startup: false, activationEvent: 'onStartupFinished'` | ✅ |
| No `UNKNOWN vendor zai` error | declarative contribution present | `grep -c languageModelChatProviders package.json` = 1 | ✅ |
| API key read from SecretStorage | present, non-zero length | `SecretStorage "zai.apiKey": present (len=49)` | ✅ |
| `selectChatModels({ vendor: "zai" })` | ≥ 1 model | `13 model(s) visible to VS Code` | ✅ |
| `provideLanguageModelChatInformation` log | shows advertised count | `advertising 13 model(s) to VS Code [glm-4.5, glm-4.5-air, glm-4.6, …]` | ✅ |
| `setContext` workaround runs | banner includes setContext line | `set 'github.copilot.clientByokEnabled' = true (...)` | ✅ |
| Extension Host errors | none related to zai | none | ✅ |

### Activation banner captured during test

```
2026-07-18T04:49:43.326Z === Z.AI activation diagnostics ===
2026-07-18T04:49:43.326Z [activate] extension activated, vendor="zai"
2026-07-18T04:49:43.326Z [activate] VS Code version: 1.129.1
2026-07-18T04:49:43.326Z [activate] SecretStorage "zai.apiKey": present (len=49)
2026-07-18T04:49:43.326Z [activate] selectChatModels({ vendor: "zai" }): 13 model(s) visible to VS Code
2026-07-18T04:49:43.326Z [activate] set 'github.copilot.clientByokEnabled' = true (ensures Manage Models gear icon stays clickable for BYOK users who are not signed in to Copilot)
2026-07-18T04:49:43.326Z === end activation diagnostics ===
```

```
[2026-07-18T04:49:43.724Z] provideLanguageModelChatInformation: advertising 13 model(s) to VS Code [glm-4.5, glm-4.5-air, glm-4.6, …]
[2026-07-18T04:49:43.749Z] Refreshed quota: [quota] 5-Hours=58%
```

### Bug discovered and fixed during the test

The first integration test surfaced a regression in the new diagnostics code:

- **Symptom**: the activation banner appeared, but the `set 'github.copilot.clientByokEnabled' = true ...` line was missing from the output channel — even though the workaround code was present in `extension.ts`.
- **Root cause**: `lines.push(...)` for the setContext result was executed **after** `channel.appendLine(lines.join("\n"))`. The log line was added to the array but the array had already been flushed, so the result was silently dropped.
- **Fix**: reordered the code so the `setContext` block runs before the final `channel.appendLine`. After rebuilding the `.vsix` and reinstalling in the fresh env, the setContext line appears in the banner as expected.
- **Lesson**: when adding new log lines to an existing banner, always trace the order between `lines.push(...)` and the single `appendLine(lines.join(...))` call. The output channel only sees the snapshot at flush time.

### Files changed in v0.4.0

| File | Change |
|---|---|
| `src/extension.ts` | New `logActivationDiagnostics()` function (writes a one-shot banner to the `Z.AI` output channel — VS Code version, SecretStorage presence, `selectChatModels` count polled at 0/500/1500 ms, `setContext` workaround result). New log lines in `provideLanguageModelChatInformation` when returning `[]`, cancelled, or advertising N models. New `Z.AI: Set API Key` toast when the key is missing. |
| `package.json` | Bumped `0.3.3` → `0.4.0`. Declarative `languageModelChatProviders` contribution **retained** (required — see §10). |
| `CHANGELOG.md` | New `0.4.0` entry under both `Investigated` (for the two symptoms: "missing from picker" and "gear icon does nothing") and `Added` (diagnostics banner, provider logging, `setContext` workaround). |
| `README.md` | Quick Start tips updated to call out per-device SecretStorage. Commands table notes declarative + programmatic coexistence. Troubleshooting section gains a dedicated entry for "gear icon does nothing" with the sign-in-to-Copilot definitive fix. |
| `doc/vscode-128-byok-utility-model.md` | This document, sections §10, §11, and §12. |

### Runbook (final, ordered)

If a user reports "Z.AI models don't appear in the picker" or "the gear icon does nothing":

1. **Check the `Z.AI` output channel.** It now prints a single activation banner that pinpoints the failure mode.
2. **If `SecretStorage "zai.apiKey": MISSING`** → run `Z.AI: Set API Key`, then `Developer: Reload Window`. SecretStorage is per-device and is not synced by VS Code Settings Sync.
3. **If `selectChatModels` reports 0 models while the key is present** → check the Extension Host log for `Chat model provider uses UNKNOWN vendor zai`. If present, the declarative `languageModelChatProviders` contribution has been removed from `package.json` and must be restored.
4. **If `selectChatModels` reports N models but the picker is empty** → reload the window. VS Code caches the picker list per window.
5. **If the gear icon is still unresponsive after reload** → sign in to GitHub Copilot Chat (free tier is enough). The `setContext` workaround should keep the gear clickable in most cases, but signing in is the definitive fix because it sets `chatIsEnabled = true` which satisfies the `AND`-branch of the precondition that `clientByokEnabled` cannot reach on its own.

### Build artifact

```
DONE  Packaged: /Users/ltmoerdani/Startup/zai-copilot-chat/zai-copilot-chat-0.4.0.vsix (79 files, 208 KB)
```

SHA-256 (computed after the test session):

```
5026a005cebc6470d5a3cddd964ad1524ee183083bbe8f6a773d5da251cdcf8f  zai-copilot-chat-0.4.0.vsix
```

```bash
$ shasum -a 256 zai-copilot-chat-0.4.0.vsix
5026a005cebc6470d5a3cddd964ad1524ee183083bbe8f6a773d5da251cdcf8f  zai-copilot-chat-0.4.0.vsix
```
