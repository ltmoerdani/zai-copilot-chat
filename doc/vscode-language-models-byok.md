# Patch: Z.AI Group in Language Models Has No "Update API Key" / "Delete Group"

> **Status:** ✅ RESOLVED
> **Date:** September 14, 2026
> **Extension version:** 0.6.4
> **Severity:** High — every button and gear icon in the Z.AI group of **Chat → Language Models** was inert: **Open in Language Models (JSON)**, **Rename Group**, **Update API Key**, and **Delete** all did nothing when clicked
> **Root Cause:** VS Code synthesizes a group for any vendor that has models but no stored group, naming it after the vendor's `displayName`. The gear menu is built from that **synthesized** name (`"Z.AI"`), but every handler looks the group up in the **real** `chatLanguageModels.json` — where no `zai` entry existed. The lookup returns `undefined`, the handler throws `Language model provider group Z.AI for vendor zai not found.`, and the surrounding `catch` swallows it. Result: a fully populated menu where every item silently does nothing.

---

## Table of Contents

1. [Summary](#1-summary)
2. [Symptom](#2-symptom)
3. [Root Cause](#3-root-cause)
4. [Evidence](#4-evidence)
5. [Why a SecretStorage-Only Key Produces This State](#5-why-a-secretstorage-only-key-produces-this-state)
6. [Fix](#6-fix)
7. [Migration for Existing Users](#7-migration-for-existing-users)
8. [Verification](#8-verification)
9. [Prevention](#9-prevention)

---

## 1. Summary

The extension accepted an API key through its own `Z.AI: Set API Key` command and stored it in VS Code `SecretStorage`. Models then appeared in the chat model picker — but the Z.AI entry in **Chat → Language Models** was inert:

- Clicking the gear icon on a Z.AI model did **nothing** (no popup, no error).
- There was no **Update API Key** item.
- There was no **Delete Group** item, so the entry could not be removed.

The extension was serving models through a path VS Code cannot manage. The fix is to route key entry through VS Code's native **BYOK** flow (`"+ Add Models…"`), which writes a real configuration group, and to keep `SecretStorage` as an internal mirror only.

---

## 2. Symptom

Reported as (translated): *"In Language Models I can't update the key, and I can't delete the group either. Nothing happens — no Update Key appears."*

Reproduction:

1. Run `Z.AI: Set API Key` (0.6.3 or earlier) and paste a valid key.
2. Open the model picker → Z.AI models are listed. ✅
3. Click the gear icon next to a Z.AI model. ❌ Nothing happens.
4. Open **Chat: Manage Language Models**. The Z.AI entry has no usable actions. ❌

---

## 3. Root Cause

### 3.1 The synthesized-group name mismatch (the real bug)

VS Code's Language Models tree synthesizes a group for any vendor that has models but **no stored group**:

```js
// addVendorModels(vendor)
let i = this.languageModelsService.getLanguageModelGroups(e.vendor);
for (let n of i) {
  let r = { group: n.group ?? { vendor: e.vendor, name: e.displayName }, vendor: e };
  //                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //                    No stored group → synthesize one named after displayName
```

The gear menu is then built from that **synthesized** name:

```js
// renderVendorElement
n.vendor.configuration
  ? a.push(...ign(this.viewModel, n.vendor, n.group.name, ...))
  //                                        ^^^^^^^^^^^^ = "Z.AI" (displayName)
```

But every handler looks the group up in the **real** configuration file:

```js
async updateLanguageModelsProviderGroupApiKey(o, e) {
  let t = this.getVendors().find(({ vendor: a }) => a === o),
      i = t?.configuration,
      n = i?.properties?.apiKey;
  if (!t || !i || !n) return;                       // silent no-op
  let r = this._languageModelsConfigurationService
            .getLanguageModelsProviderGroups()
            .find(a => a.vendor === o && a.name === e);   // ← e = "Z.AI"
  if (!r) throw new Error(`Language model provider group ${e} for vendor ${o} not found.`);
  ...
}
```

With **no `zai` entry** in `chatLanguageModels.json`, that `find()` returns `undefined` and the handler throws:

```
Language model provider group Z.AI for vendor zai not found.
```

The throw is swallowed by the surrounding `catch (a) { if (Li(a)) return; throw a }` — and `Li()` only matches cancellation errors. So the UI looks completely dead: **a fully populated menu where every item silently does nothing.**

The same mismatch breaks all four actions:

| Menu item | Handler | Failure |
|---|---|---|
| Open in Language Models (JSON) | `openLanguageModelsProviderGroupSettings` | group not found → throws |
| Rename Group | `renameLanguageModelsProviderGroup` | group not found → throws |
| Update API Key | `updateLanguageModelsProviderGroupApiKey` | group not found → throws |
| Delete | `removeLanguageModelsProviderGroup` | group not found → throws |

### 3.2 The empty-menu case

If the vendor has **no `configuration`** at all, `ign()` returns `[]` before any of the above:

```js
function ign(s, o, e, t, i) {
  let n = o.configuration;
  if (!n) return [];        // ← empty menu, nothing to click
  ...
}
```

### 3.3 Model resolution runs in two passes

```js
// 1. groupless call — no configuration
await provider.provideLanguageModelChatInfo({ silent });
// 2. one call per configured group
for (const group of getLanguageModelsProviderGroups()) {
  const configuration = await resolveConfiguration(group, providerDescriptor.configuration);
  await provider.provideLanguageModelChatInfo({ group: group.name, configuration });
}
```

The extension (0.6.3) only ever served models from pass 1, using `SecretStorage`. Pass 2 never ran because there was no `zai` group. Result: models on screen, but no manageable group behind them.

---

## 4. Evidence

`~/Library/Application Support/Code/User/chatLanguageModels.json` before the fix:

```json
[
  { "name": "MiMo (Xiaomi)", "vendor": "mimo",              "apiKey": "${input:chat.lm.secret.-40e3319d}" },
  { "name": "Cline",         "vendor": "cline-copilot-chat", "apiKey": "${input:chat.lm.secret.-2982e9c4}" },
  { "name": "OpenCode Go",   "vendor": "opencodego",        "apiKey": "${input:chat.lm.secret.-3a6af0aa}" },
  { "name": "OpenCode Zen",  "vendor": "opencodezen",       "apiKey": "${input:chat.lm.secret.-13183f20}" },
  { "name": "ZenMux",        "vendor": "customendpoint",    "apiKey": "${input:chat.lm.secret.-315725d0}" }
]
```

**No `zai` entry.** Every other BYOK provider in this profile has one; Z.AI was the only vendor configured purely through `SecretStorage`.

Activation diagnostics from the affected machine confirmed the split:

```
[activate] SecretStorage "zai.apiKey": present (len=49)
[activate] selectChatModels({ vendor: "zai" }): 15 model(s) visible to VS Code
```

Models resolve (pass 1 works) — but no group exists for the UI to manage.

---

## 5. Why a SecretStorage-Only Key Produces This State

| Aspect | Key in `SecretStorage` only (old) | Key via native BYOK (new) |
|---|---|---|
| Entry in `chatLanguageModels.json` | ❌ absent | ✅ `{"name":"Z.AI","vendor":"zai","apiKey":"${input:…}"}` |
| Model source in VS Code | groupless call (pass 1) | per-group call (pass 2) |
| Gear menu on the group | empty → **nothing happens** | settings / rename / **Update API Key** / **Delete Group** |
| Key update path | extension command only | VS Code UI **and** extension command |
| Key removal | manual config edit | **Delete Group** |

Note that `SecretStorage` is still valuable as an **internal mirror** — it lets agent-host variants and cold-start requests resolve the key before the BYOK group is read. It must not be the *only* home for the key.

---

## 6. Fix

### 6.1 Create a real `zai` group (fixes the dead menu)

`src/extension.ts` — `ZaiProvider.ensureLanguageModelsGroup()`:

Writes a real entry into VS Code's `chatLanguageModels.json` so the synthesized
group name (`"Z.AI"`) matches a real group and every handler's `find()` succeeds:

```json
{ "name": "Z.AI", "vendor": "zai", "apiKey": "${input:chat.lm.secret.zai-…}" }
```

- The key is mirrored into VS Code's own secret storage under a
  `chat.lm.secret.*` name and referenced with the `${input:…}` placeholder —
  the exact format VS Code itself writes.
- Idempotent: returns early if a `zai` group already exists.
- Tolerates a missing or malformed file (VS Code creates it on first BYOK use).
- Preserves VS Code's 4-space indentation.
- Called from `promptAndStoreApiKey()` and, for users who already have a key,
  from activation via `ensureLanguageModelsGroupForExistingKey()` (deferred with
  `queueMicrotask` so activation is never blocked by filesystem work).

**Path resolution.** The config path is derived from
`context.globalStorageUri`, which VS Code resolves to
`<user-data-dir>/User/globalStorage/<extension-id>` on every platform —
including portable installs and custom `--user-data-dir`. Walking up two levels
yields `<user-data-dir>/User`:

```ts
private languageModelsConfigUri(): vscode.Uri {
  const userDir = vscode.Uri.joinPath(this.context.globalStorageUri, "..", "..");
  return vscode.Uri.joinPath(userDir, "chatLanguageModels.json");
}
```

This deliberately avoids `process.env` / `process.platform` probing, which was
both platform-fragile (it missed portable installs and `--user-data-dir`) and
the source of `Cannot find name 'process'` diagnostics in editors whose
TypeScript service did not auto-include `@types/node`. File I/O uses
`TextEncoder` / `TextDecoder` instead of `Buffer` for the same reason.

`tsconfig.json` also declares `"types": ["node", "vscode"]` so the Node globals
used elsewhere in the codebase (`src/research/cache.ts`,
`src/vision/visionBridge.ts`) resolve consistently in the editor as well as on
the command line.

### 6.2 Provider call shapes

`src/extension.ts` — `ZaiProvider.provideLanguageModelChatInformation`:

1. **Resolve the BYOK key first** from `options.configuration.apiKey` (trimmed, non-empty).
2. **Mark the vendor as BYOK-configured** when a key arrives that way (`hasByokGroupConfigured`).
3. **Suppress per-model configuration groups** — a call with `configuration !== undefined` but no `apiKey` is a settings-only group (`reasoningEffort` etc.). Returning `[]` there stops every model being listed twice.
4. **Suppress the groupless call** once a BYOK group has been observed, so the group's model set is authoritative.
5. **Mirror the resolved key into `SecretStorage`** so agent variants and cold-start inherit it.
6. **Stable `family: "glm"`** for all models (was `zai-${modelId}`), so VS Code's family-based grouping/selection works instead of creating an ungroupable entry per model.

### 6.3 Key entry UX

- `Z.AI: Set API Key` → retitled **`Z.AI: Set / Update API Key`**; it prompts for a key, stores it in `SecretStorage`, creates the `zai` group, and refreshes models.
- `Manage Provider` menu: **Set / Update API Key (stored by this extension)**, **Open Language Models (BYOK)…**, **Clear Legacy API Key (SecretStorage)**, Test Connection, Refresh Models, Show Quota.
- `package.json`: the `zai` vendor declares **`"managementCommand": "zai.manage"`**, giving VS Code a working fallback action for the vendor.
- `Test Connection`, `Show Quota`, the activation toast, `@z-research` pre-flight, and the output-channel log now all point at a working key-entry path when no key is configured.

---

## 7. Migration for Existing Users

**No manual migration needed.** On the next activation the extension creates the
`zai` group automatically if a key is already stored. To do it immediately:

1. Command Palette → **Z.AI: Set / Update API Key** and paste the key.
2. Reload the window (`Developer: Reload Window`).
3. Verify `chatLanguageModels.json` now contains a `zai` entry.

After that, all four gear-menu actions work: **Open in Language Models (JSON)**,
**Rename Group**, **Update API Key**, and **Delete**.

---

## 8. Verification

| Check | Result |
|---|---|
| `npm run compile` (tsc) | ✅ 0 errors |
| `npm test` | ✅ 151 pass / 0 fail |
| `ensureLanguageModelsGroup()` writes a findable `zai` entry | ✅ simulated against the real config file |
| Handler lookup `find(vendor='zai', name='Z.AI')` | ✅ FOUND (was `undefined` → threw) |
| Written JSON is valid with 4-space indent | ✅ |
| Models are not listed twice once the group exists | ✅ (groupless call returns `[]`) |

Manual verification in the Extension Development Host: add Z.AI via `"+ Add Models…"`, confirm the gear menu is populated, update the key, then confirm models still resolve and the group can be deleted.

---

## 9. Prevention

- **Never make `SecretStorage` the only home for a provider API key.** A key VS Code does not know about produces a group VS Code cannot manage. Keep `SecretStorage` as a mirror, and treat the BYOK configuration entry as the source of truth.
- **Always implement both provider call shapes**: the groupless call *and* the per-group call with `options.configuration`. Returning the full model list on both duplicates every model.
- **Never derive `family` from the model id.** A per-model unique family string breaks VS Code's family-based grouping and selection; use a stable, real family name.
- **Always declare a `managementCommand`** for a `languageModelChatProviders` vendor. It is the only guaranteed-working action when VS Code's built-in group handlers silently no-op.
- When a VS Code UI affordance "does nothing", verify the workbench precondition from the shipped `workbench.desktop.main.js` before changing extension code — the empty menu here came from `if (!configuration) return []`, not from the extension's own commands.
