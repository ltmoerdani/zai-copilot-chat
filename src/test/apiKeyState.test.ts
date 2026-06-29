import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiKeyRegistry,
  GLOBAL_TARGET,
  WORKSPACE_TARGET,
  WORKSPACE_FOLDER_TARGET,
  collectConfiguredApiKeysFromInspect,
  collectKnownApiKeys,
  hasAnyKnownApiKey,
  planApiKeyClear,
} from "../apiKeyState";

test("ApiKeyRegistry adds and removes keys without duplicates", () => {
  const registry = new ApiKeyRegistry();

  assert.equal(registry.add("alpha-key"), true);
  assert.equal(registry.add("alpha-key"), false);
  assert.deepEqual(registry.values(), ["alpha-key"]);

  assert.equal(registry.remove("alpha-key"), true);
  assert.deepEqual(registry.values(), []);
  assert.equal(registry.hasAny(), false);
});

test("ApiKeyRegistry updates a key in place", () => {
  const registry = new ApiKeyRegistry(["old-key"]);

  assert.equal(registry.replace("old-key", "new-key"), true);
  assert.deepEqual(registry.values(), ["new-key"]);
  assert.equal(registry.hasAny(), true);

  assert.equal(registry.remove("new-key"), true);
  assert.deepEqual(registry.values(), []);
});

test("ApiKeyRegistry.replace is a no-op when old === new", () => {
  const registry = new ApiKeyRegistry(["stable-key"]);

  // Replacing a key with itself must not report a change.
  assert.equal(registry.replace("stable-key", "stable-key"), false);
  assert.deepEqual(registry.values(), ["stable-key"]);
});

test("ApiKeyRegistry normalizes (trims) and dedupes input", () => {
  const registry = new ApiKeyRegistry();

  assert.equal(registry.add("  same-key  "), true);
  // Whitespace-only differences must collapse to the same entry.
  assert.equal(registry.add("same-key"), false);
  assert.equal(registry.add(""), false);
  assert.equal(registry.add("   "), false);
  assert.deepEqual(registry.values(), ["same-key"]);
});

test("planApiKeyClear returns nothing when there is no key to clear", () => {
  assert.deepEqual(planApiKeyClear(undefined), []);
  assert.deepEqual(planApiKeyClear({}), []);
});

test("planApiKeyClear emits the three flat targets when only globalValue is set", () => {
  const steps = planApiKeyClear({ globalValue: "global-key" });

  assert.deepEqual(steps, [
    { target: GLOBAL_TARGET },
    { target: WORKSPACE_TARGET },
    { target: WORKSPACE_FOLDER_TARGET },
  ]);
});

test("planApiKeyClear adds one (target, languageId) step per language override", () => {
  // Two language overrides + the three flat targets => 3 + (2 * 3) = 9 steps.
  const steps = planApiKeyClear({
    globalValue: "global-key",
    languageIds: ["markdown", "python"],
  });

  assert.equal(steps.length, 9);

  // Flat targets come first...
  assert.deepEqual(steps.slice(0, 3), [
    { target: GLOBAL_TARGET },
    { target: WORKSPACE_TARGET },
    { target: WORKSPACE_FOLDER_TARGET },
  ]);

  // ...then each languageId repeated across the three targets, in order.
  assert.deepEqual(steps.slice(3, 6), [
    { target: GLOBAL_TARGET, languageId: "markdown" },
    { target: WORKSPACE_TARGET, languageId: "markdown" },
    { target: WORKSPACE_FOLDER_TARGET, languageId: "markdown" },
  ]);
  assert.deepEqual(steps.slice(6, 9), [
    { target: GLOBAL_TARGET, languageId: "python" },
    { target: WORKSPACE_TARGET, languageId: "python" },
    { target: WORKSPACE_FOLDER_TARGET, languageId: "python" },
  ]);
});

test("Known-key detection merges secret, cached, and configured values", () => {
  assert.equal(hasAnyKnownApiKey({ secretApiKey: "secret-key" }), true);
  assert.equal(hasAnyKnownApiKey({ cachedApiKeys: ["cached-key"] }), true);
  assert.equal(hasAnyKnownApiKey({ configuredApiKeys: ["configured-key"] }), true);

  // collectKnownApiKeys dedupes across sources; order is not contractual,
  // so compare as sorted sets to keep the test robust against Set iteration
  // order changes.
  const sort = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    sort(
      collectKnownApiKeys({
        secretApiKey: "secret-key",
        cachedApiKeys: ["cached-key", "secret-key"],
        configuredApiKeys: ["configured-key", "cached-key"],
      }),
    ),
    sort(["secret-key", "cached-key", "configured-key"]),
  );

  assert.deepEqual(
    sort(
      collectConfiguredApiKeysFromInspect({
        globalValue: "global-key",
        workspaceValue: "workspace-key",
        workspaceFolderValue: "workspace-folder-key",
        // Language-scoped overrides must be collected too — otherwise
        // clearConfiguredProviderApiKey would miss them.
        globalLanguageValue: "global-lang-key",
        workspaceLanguageValue: "workspace-lang-key",
        workspaceFolderLanguageValue: "workspace-folder-lang-key",
      }),
    ),
    sort([
      "global-key",
      "workspace-key",
      "workspace-folder-key",
      "global-lang-key",
      "workspace-lang-key",
      "workspace-folder-lang-key",
    ]),
  );
});
