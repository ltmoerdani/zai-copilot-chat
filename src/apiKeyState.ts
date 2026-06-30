export interface ApiKeyInspect<T> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  globalLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
  /**
   * All language identifiers for which the inspected key has an override.
   * Mirrors `vscode.WorkspaceConfiguration.inspect().languageIds`.
   */
  languageIds?: readonly string[];
}

/**
 * One configuration mutation needed to fully wipe `zai.apiKey`.
 *
 * `languageId` is set only for language-scoped overrides and must be applied
 * via a language-scoped configuration (`getConfiguration("zai", { languageId })`)
 * with `overrideInLanguage: true`.
 */
export interface ApiKeyClearStep {
  target: number;
  languageId?: string;
}

/**
 * Numeric ConfigurationTarget values, mirroring
 * `vscode.ConfigurationTarget.{Global, Workspace, WorkspaceFolder}`.
 * Duplicated here so `planApiKeyClear` stays free of `vscode` imports and
 * remains unit-testable in plain Node.
 */
export const GLOBAL_TARGET = 1;
export const WORKSPACE_TARGET = 2;
export const WORKSPACE_FOLDER_TARGET = 3;

/**
 * Pure description of the configuration updates required to remove
 * `zai.apiKey` from every layer it might live in:
 * - the three flat targets (Global / Workspace / WorkspaceFolder), and
 * - every language-scoped override reported by `inspect().languageIds`.
 *
 * Splitting this out from the I/O lets us unit-test the sequencing without
 * mocking `vscode.workspace`. The caller is responsible for executing each
 * step against the appropriate (possibly language-scoped) configuration.
 */
export function planApiKeyClear(inspect: ApiKeyInspect<string> | undefined): ApiKeyClearStep[] {
  if (!inspect) {
    return [];
  }

  const keys = collectConfiguredApiKeysFromInspect(inspect);
  if (keys.length === 0) {
    return [];
  }

  const targets = [
    GLOBAL_TARGET,
    WORKSPACE_TARGET,
    WORKSPACE_FOLDER_TARGET,
  ];

  const steps: ApiKeyClearStep[] = targets.map((target) => ({ target }));

  for (const languageId of inspect.languageIds ?? []) {
    for (const target of targets) {
      steps.push({ target, languageId });
    }
  }

  return steps;
}

function normalizeApiKey(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class ApiKeyRegistry {
  private readonly keys = new Set<string>();

  constructor(initialValues: readonly string[] = []) {
    for (const value of initialValues) {
      this.add(value);
    }
  }

  add(value: string): boolean {
    const normalized = normalizeApiKey(value);
    if (!normalized) {
      return false;
    }

    if (this.keys.has(normalized)) {
      return false;
    }

    this.keys.add(normalized);
    return true;
  }

  remove(value: string): boolean {
    const normalized = normalizeApiKey(value);
    if (!normalized) {
      return false;
    }

    return this.keys.delete(normalized);
  }

  replace(oldValue: string, newValue: string): boolean {
    const oldNormalized = normalizeApiKey(oldValue);
    const newNormalized = normalizeApiKey(newValue);

    if (!oldNormalized || !newNormalized) {
      return false;
    }

    // No-op when the key is identical to avoid reporting a spurious change.
    if (oldNormalized === newNormalized) {
      return false;
    }

    if (!this.keys.delete(oldNormalized)) {
      return false;
    }

    this.keys.add(newNormalized);
    return true;
  }

  hasAny(): boolean {
    return this.keys.size > 0;
  }

  values(): string[] {
    return Array.from(this.keys);
  }
}

export function collectConfiguredApiKeysFromInspect(
  inspect: ApiKeyInspect<string> | undefined,
): string[] {
  const values = new Set<string>();
  const track = (value: string | undefined) => {
    const normalized = normalizeApiKey(value);
    if (normalized) {
      values.add(normalized);
    }
  };

  track(inspect?.globalValue);
  track(inspect?.workspaceValue);
  track(inspect?.workspaceFolderValue);
  track(inspect?.globalLanguageValue);
  track(inspect?.workspaceLanguageValue);
  track(inspect?.workspaceFolderLanguageValue);

  return Array.from(values);
}

export function collectKnownApiKeys(options: {
  secretApiKey?: string | null;
  cachedApiKeys?: readonly string[];
  configuredApiKeys?: readonly string[];
}): string[] {
  const registry = new ApiKeyRegistry();

  for (const value of [options.secretApiKey, ...(options.cachedApiKeys ?? []), ...(options.configuredApiKeys ?? [])]) {
    registry.add(value ?? "");
  }

  return registry.values();
}

export function hasAnyKnownApiKey(options: {
  secretApiKey?: string | null;
  cachedApiKeys?: readonly string[];
  configuredApiKeys?: readonly string[];
}): boolean {
  return collectKnownApiKeys(options).length > 0;
}
