import { AsyncLocalStorage } from "node:async_hooks";
import * as vscode from "vscode";
import type { UsageSnapshot } from "./usage";

type HandleProgressChunkFn = (
  requestId: string,
  chunks: unknown[],
) => Promise<void>;

type CapturedProxy = {
  proxyTarget: Record<string, unknown>;
  originalHandleProgressChunk: HandleProgressChunkFn;
};

type ContextWindowUsage = {
  promptTokens: number;
  completionTokens: number;
  outputBuffer?: number;
};

type SetAddFn = typeof Set.prototype.add;
type SetDeleteFn = typeof Set.prototype.delete;

let originalHandleProgressChunk: HandleProgressChunkFn | null = null;
let patchedHandleProgressChunk: HandleProgressChunkFn | null = null;
let proxyTarget: Record<string, unknown> | null = null;
let originalSetAdd: SetAddFn | null = null;
let originalSetDelete: SetDeleteFn | null = null;
let patchedSetAdd: SetAddFn | null = null;
let patchedSetDelete: SetDeleteFn | null = null;
let requestTrackingInstalled = false;
let hookInstalled = false;
let initializationGeneration = 0;

const inFlightRequestIds = new Map<string, true>();
const localToVsCodeRequestIds = new Map<string, string>();
const vsCodeToLocalRequestIds = new Map<string, string>();
const pendingUsage = new Map<string, ContextWindowUsage>();
const pendingUsageByLocalRequestId = new Map<string, ContextWindowUsage>();
const outputBuffersByLocalRequestId = new Map<string, number>();
const requestContextStorage = new AsyncLocalStorage<string>();
const queuedProgressLocalRequestIds: string[] = [];
const queuedProgressLocalRequestIdSet = new Set<string>();

function isContextIndicatorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("zai")
    .get("experimentalContextIndicator", false);
}

function createUsageChunk(usage: ContextWindowUsage): {
  kind: "usage";
  promptTokens: number;
  completionTokens: number;
  outputBuffer?: number;
} {
  return {
    kind: "usage",
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ...(usage.outputBuffer === undefined
      ? {}
      : { outputBuffer: usage.outputBuffer }),
  };
}

function queueProgressBinding(localRequestId: string): void {
  if (
    localToVsCodeRequestIds.has(localRequestId) ||
    queuedProgressLocalRequestIdSet.has(localRequestId)
  ) {
    return;
  }

  queuedProgressLocalRequestIds.push(localRequestId);
  queuedProgressLocalRequestIdSet.add(localRequestId);
}

function discardQueuedProgressBinding(localRequestId: string): void {
  queuedProgressLocalRequestIdSet.delete(localRequestId);
}

function takeQueuedProgressBinding(): string | undefined {
  while (queuedProgressLocalRequestIds.length > 0) {
    const localRequestId = queuedProgressLocalRequestIds.shift();
    if (!localRequestId) {
      continue;
    }
    if (!queuedProgressLocalRequestIdSet.delete(localRequestId)) {
      continue;
    }
    if (!localToVsCodeRequestIds.has(localRequestId)) {
      return localRequestId;
    }
  }

  return undefined;
}

function injectUsageChunk(requestId: string, usage: ContextWindowUsage): void {
  if (!proxyTarget || !originalHandleProgressChunk) {
    return;
  }

  void originalHandleProgressChunk
    .call(proxyTarget, requestId, [createUsageChunk(usage)])
    .catch(() => undefined);
}

function bindLocalRequestToVsCodeRequest(
  localRequestId: string,
  requestId: string,
): void {
  discardQueuedProgressBinding(localRequestId);

  const previousRequestId = localToVsCodeRequestIds.get(localRequestId);
  if (previousRequestId && previousRequestId !== requestId) {
    vsCodeToLocalRequestIds.delete(previousRequestId);
    pendingUsage.delete(previousRequestId);
  }

  const previousLocalRequestId = vsCodeToLocalRequestIds.get(requestId);
  if (previousLocalRequestId && previousLocalRequestId !== localRequestId) {
    localToVsCodeRequestIds.delete(previousLocalRequestId);
    pendingUsageByLocalRequestId.delete(previousLocalRequestId);
    outputBuffersByLocalRequestId.delete(previousLocalRequestId);
  }

  localToVsCodeRequestIds.set(localRequestId, requestId);
  vsCodeToLocalRequestIds.set(requestId, localRequestId);

  const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
  if (pendingLocalUsage) {
    pendingUsage.set(requestId, pendingLocalUsage);
    pendingUsageByLocalRequestId.delete(localRequestId);
    injectUsageChunk(requestId, pendingLocalUsage);
  }
}

function cleanupVsCodeRequest(requestId: string): void {
  inFlightRequestIds.delete(requestId);
  pendingUsage.delete(requestId);

  const localRequestId = vsCodeToLocalRequestIds.get(requestId);
  if (!localRequestId) {
    return;
  }

  vsCodeToLocalRequestIds.delete(requestId);
  const mappedRequestId = localToVsCodeRequestIds.get(localRequestId);
  if (mappedRequestId === requestId) {
    localToVsCodeRequestIds.delete(localRequestId);
  }
  outputBuffersByLocalRequestId.delete(localRequestId);
}

async function captureProxy(
  logDiagnostic?: (message: string) => void,
): Promise<CapturedProxy | null> {
  try {
    // Walk the Copilot Chat extension's module to find the handleProgressChunk method
    // This is fragile and depends on VS Code internals
    const copilotExtension = vscode.extensions.getExtension("GitHub.copilot-chat");
    if (!copilotExtension?.isActive) {
      logDiagnostic?.("contextWindowHook: GitHub.copilot-chat extension not active");
      return null;
    }

    const exports = copilotExtension.exports as Record<string, unknown> | undefined;
    if (!exports) {
      logDiagnostic?.("contextWindowHook: no exports from copilot-chat");
      return null;
    }

    // Look for the internal chat provider instance that has handleProgressChunk
    // This probes known internal property paths
    const candidates = [
      exports,
      (exports as Record<string, unknown>).ChatProvider,
      (exports as Record<string, unknown>).ChatAgent,
      (exports as Record<string, unknown>).ChatService,
    ];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const proxyTarget = candidate as Record<string, unknown>;
      const original = proxyTarget.$handleProgressChunk as HandleProgressChunkFn | undefined;
      if (typeof original === "function") {
        return { proxyTarget, originalHandleProgressChunk: original };
      }

      // Also check for handleProgressChunk directly
      const direct = proxyTarget.handleProgressChunk as HandleProgressChunkFn | undefined;
      if (typeof direct === "function") {
        return { proxyTarget, originalHandleProgressChunk: direct };
      }
    }

    logDiagnostic?.("contextWindowHook: could not find handleProgressChunk in copilot-chat exports");
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiagnostic?.(`contextWindowHook: error capturing proxy — ${message}`);
    return null;
  }
}

function patchProxy(captured: CapturedProxy): void {
  if (hookInstalled) {
    return;
  }

  const target = captured.proxyTarget;
  const original = captured.originalHandleProgressChunk;
  const patched: HandleProgressChunkFn = function (
    requestId: string,
    chunks: unknown[],
  ): Promise<void> {
    let localRequestId = requestContextStorage.getStore();
    if (!localRequestId && !vsCodeToLocalRequestIds.has(requestId)) {
      localRequestId = takeQueuedProgressBinding();
    }
    if (localRequestId) {
      bindLocalRequestToVsCodeRequest(localRequestId, requestId);
    }

    const stored = pendingUsage.get(requestId);
    if (stored) {
      for (let index = 0; index < chunks.length; index += 1) {
        const raw = chunks[index];
        const chunk = (Array.isArray(raw) ? raw[0] : raw) as
          | Record<string, unknown>
          | undefined;
        if (chunk?.kind === "usage") {
          chunk.promptTokens = stored.promptTokens;
          chunk.completionTokens = stored.completionTokens;
          if (stored.outputBuffer !== undefined) {
            chunk.outputBuffer = stored.outputBuffer;
          }
        }
      }
    }

    return original.call(target, requestId, chunks);
  };

  proxyTarget = target;
  originalHandleProgressChunk = original;
  patchedHandleProgressChunk = patched;
  (target as { $handleProgressChunk?: HandleProgressChunkFn }).$handleProgressChunk =
    patched;
  hookInstalled = true;
}

function unpatchProxy(): void {
  if (
    proxyTarget &&
    originalHandleProgressChunk &&
    patchedHandleProgressChunk &&
    (proxyTarget as { $handleProgressChunk?: HandleProgressChunkFn })
      .$handleProgressChunk === patchedHandleProgressChunk
  ) {
    (proxyTarget as { $handleProgressChunk?: HandleProgressChunkFn }).$handleProgressChunk =
      originalHandleProgressChunk;
  }

  patchedHandleProgressChunk = null;
  originalHandleProgressChunk = null;
  proxyTarget = null;
  hookInstalled = false;
}

function installRequestTracking(): void {
  if (requestTrackingInstalled) {
    return;
  }

  const capturedOriginalAdd = Set.prototype.add;
  const capturedOriginalDelete = Set.prototype.delete;

  const nextPatchedAdd: SetAddFn = function <T>(this: Set<T>, value: T): Set<T> {
    if (isRecord(value) && typeof value.requestId === "string" && "extRequest" in value) {
      inFlightRequestIds.set(value.requestId, true);
    }

    return capturedOriginalAdd.call(this, value);
  };

  const nextPatchedDelete: SetDeleteFn = function <T>(
    this: Set<T>,
    value: T,
  ): boolean {
    if (isRecord(value) && typeof value.requestId === "string" && "extRequest" in value) {
      cleanupVsCodeRequest(value.requestId);
    }

    return capturedOriginalDelete.call(this, value);
  };

  originalSetAdd = capturedOriginalAdd;
  originalSetDelete = capturedOriginalDelete;
  patchedSetAdd = nextPatchedAdd;
  patchedSetDelete = nextPatchedDelete;
  Set.prototype.add = nextPatchedAdd;
  Set.prototype.delete = nextPatchedDelete;
  requestTrackingInstalled = true;
}

function uninstallRequestTracking(): void {
  if (patchedSetAdd && originalSetAdd && Set.prototype.add === patchedSetAdd) {
    Set.prototype.add = originalSetAdd;
  }
  if (patchedSetDelete && originalSetDelete && Set.prototype.delete === patchedSetDelete) {
    Set.prototype.delete = originalSetDelete;
  }

  patchedSetAdd = null;
  patchedSetDelete = null;
  originalSetAdd = null;
  originalSetDelete = null;
  requestTrackingInstalled = false;
}

function normalizeUsage(usage: UsageSnapshot): ContextWindowUsage | null {
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;

  if (promptTokens === 0 && completionTokens === 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
  };
}

function normalizeOutputBuffer(outputBuffer: number): number | undefined {
  if (!Number.isFinite(outputBuffer) || outputBuffer <= 0) {
    return undefined;
  }

  return Math.floor(outputBuffer);
}

function withOutputBuffer(
  localRequestId: string,
  usage: ContextWindowUsage,
): ContextWindowUsage {
  const outputBuffer = outputBuffersByLocalRequestId.get(localRequestId);
  return outputBuffer === undefined ? usage : { ...usage, outputBuffer };
}

export function reportUsageToContextWindowForRequest(
  localRequestId: string,
  usage: UsageSnapshot,
): boolean {
  if (!isContextIndicatorEnabled()) {
    return false;
  }

  const normalized = normalizeUsage(usage);
  if (!normalized) {
    return false;
  }

  if (!proxyTarget || !originalHandleProgressChunk) {
    return false;
  }

  const usageWithOutputBuffer = withOutputBuffer(localRequestId, normalized);
  const requestId = localToVsCodeRequestIds.get(localRequestId);
  if (!requestId) {
    pendingUsageByLocalRequestId.set(localRequestId, usageWithOutputBuffer);
    return false;
  }

  pendingUsage.set(requestId, usageWithOutputBuffer);
  injectUsageChunk(requestId, usageWithOutputBuffer);
  return true;
}

export function setContextWindowOutputBufferForRequest(
  localRequestId: string,
  outputBuffer: number,
): void {
  if (!isContextIndicatorEnabled()) {
    return;
  }

  const normalizedOutputBuffer = normalizeOutputBuffer(outputBuffer);
  if (normalizedOutputBuffer === undefined) {
    outputBuffersByLocalRequestId.delete(localRequestId);
    return;
  }

  outputBuffersByLocalRequestId.set(localRequestId, normalizedOutputBuffer);

  const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
  if (pendingLocalUsage) {
    pendingUsageByLocalRequestId.set(localRequestId, {
      ...pendingLocalUsage,
      outputBuffer: normalizedOutputBuffer,
    });
  }

  const requestId = localToVsCodeRequestIds.get(localRequestId);
  if (!requestId) {
    return;
  }

  const pendingRequestUsage = pendingUsage.get(requestId);
  if (pendingRequestUsage) {
    pendingUsage.set(requestId, {
      ...pendingRequestUsage,
      outputBuffer: normalizedOutputBuffer,
    });
  }
}

export function withContextWindowRequest<T>(
  localRequestId: string,
  fn: () => T,
): T {
  return requestContextStorage.run(localRequestId, fn);
}

export function reportProgressWithContextWindowRequest(
  localRequestId: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: vscode.LanguageModelResponsePart,
): void {
  queueProgressBinding(localRequestId);
  withContextWindowRequest(localRequestId, () => {
    progress.report(part);
  });
}

export function clearContextWindowRequest(localRequestId: string): void {
  discardQueuedProgressBinding(localRequestId);
  pendingUsageByLocalRequestId.delete(localRequestId);
  outputBuffersByLocalRequestId.delete(localRequestId);
}

export function disposeContextWindowHook(): boolean {
  const hadState =
    hookInstalled ||
    requestTrackingInstalled ||
    inFlightRequestIds.size > 0 ||
    pendingUsage.size > 0 ||
    pendingUsageByLocalRequestId.size > 0 ||
    outputBuffersByLocalRequestId.size > 0 ||
    localToVsCodeRequestIds.size > 0 ||
    vsCodeToLocalRequestIds.size > 0 ||
    queuedProgressLocalRequestIdSet.size > 0;

  initializationGeneration += 1;
  unpatchProxy();
  uninstallRequestTracking();
  inFlightRequestIds.clear();
  pendingUsage.clear();
  pendingUsageByLocalRequestId.clear();
  outputBuffersByLocalRequestId.clear();
  localToVsCodeRequestIds.clear();
  vsCodeToLocalRequestIds.clear();
  queuedProgressLocalRequestIds.length = 0;
  queuedProgressLocalRequestIdSet.clear();

  return hadState;
}

export async function initializeContextWindowHook(
  logDiagnostic?: (message: string) => void,
): Promise<boolean> {
  if (!isContextIndicatorEnabled()) {
    return false;
  }

  if (hookInstalled) {
    logDiagnostic?.("contextWindowHook: already installed, skipping re-initialization");
    return true;
  }

  const generation = ++initializationGeneration;
  installRequestTracking();
  const captured = await captureProxy(logDiagnostic);

  if (generation !== initializationGeneration || !isContextIndicatorEnabled()) {
    logDiagnostic?.("contextWindowHook: initialization aborted (generation mismatch or config disabled)");
    return false;
  }

  if (!captured) {
    uninstallRequestTracking();
    inFlightRequestIds.clear();
    pendingUsage.clear();
    pendingUsageByLocalRequestId.clear();
    outputBuffersByLocalRequestId.clear();
    localToVsCodeRequestIds.clear();
    vsCodeToLocalRequestIds.clear();
    queuedProgressLocalRequestIds.length = 0;
    queuedProgressLocalRequestIdSet.clear();

    logDiagnostic?.("contextWindowHook: proxy capture failed — the Copilot Chat internals may have changed in this VS Code version");
    return false;
  }

  patchProxy(captured);
  logDiagnostic?.("contextWindowHook: proxy captured and patched successfully");
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
