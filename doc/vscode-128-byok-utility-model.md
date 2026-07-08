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
