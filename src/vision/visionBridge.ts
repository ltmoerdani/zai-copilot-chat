/**
 * Vision bridge — VS Code wrapper around the modlens CLI.
 *
 * Give text-only GLM models "sight" in Copilot Chat: when a request carries
 * image DataParts (screenshots pasted or attached by the user), this bridge
 * converts each image to structured textual evidence via modlens BEFORE the
 * request is sent to the Z.AI coding endpoint (which only accepts
 * `content.type: "text"` — the reason images are otherwise dropped silently).
 *
 * Design (see doc/modlens-vision-bridge-evaluation.md):
 * - Request-time conversion in the provider pre-pass — the API payload stays
 *   text-only, byte-identical to today's requests apart from added evidence.
 * - Two-tier caching keyed by sha256(image bytes + prompt override):
 *   in-memory LRU (EvidenceCache) + persistent sidecar JSON files under
 *   globalStorage/vision-cache/. VS Code replays the full conversation history
 *   every turn, so caching is what keeps follow-up turns from re-billing.
 * - Failure = graceful degradation: a short notice replaces the image so the
 *   model at least knows an image exists. The chat request NEVER breaks.
 *
 * This file is the only vision module allowed to import `vscode` — the rest
 * (`modlensTypes/Args/Output`, `evidenceCache`) stay pure for unit testing.
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { isInternalDataPart } from "../chatParts.js";
import { pLimit } from "../research/pLimit.js";
import { buildModlensAnalyzeArgs, resolveBinCommand } from "./modlensArgs.js";
import {
  describeModlensEngine,
  extractFailureReason,
  formatEvidenceBlock,
  parseModlensOutput,
} from "./modlensOutput.js";
import type { ModlensOutput } from "./modlensTypes.js";
import {
  EvidenceCache,
  evidenceCacheFileName,
  evidenceCacheKey,
  type EvidenceCacheEntry,
} from "./evidenceCache.js";
import {
  describeNoEngine,
  parseModlensDoctor,
  pickReuseTarget,
  type AgentHarness,
} from "./modlensDoctor.js";
import type { DoctorState } from "./modlensDoctor.js";

/** Sentinels in the evidence block when a read needs a re-run after re-provision. */
export const VISION_EVIDENCE_MARKER =
  "<vision-evidence re-read required>";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface VisionBridgeSettings {
  enabled: boolean;
  /** Executable, optionally with leading args (`npx -y @liustack/modlens@3.18.3`). */
  bin: string;
  /**
   * When the configured bin is unavailable (ENOENT), we retry once through
   * npx so modlens is auto-fetched from the npm registry on first use.
   */
  npxBypass: boolean;
  /** Pin one modlens provider. Empty = modlens failover chain. */
  provider: string;
  /**
   * Auto-provision a vision engine: install the npx-bypassed modlens, then
   * detect local agent CLIs (codex/opencode) that already hold vision and
   * grant `reuse.<harness>` automatically. Defaults to agent CLIs only (no
   * paid-subscription reuse without consent).
   */
  autoReuse: string[];
  /** Per-read timeout in ms. */
  timeoutMs: number;
  /** Hard cap for one formatted evidence block. */
  maxEvidenceChars: number;
  /** Emit a short "reading images" text part while reads run. */
  announce: boolean;
  /** Optional `--prompt` focus forwarded to the vision engine. */
  promptTemplate: string;
  /** Persistent cache TTL in hours. 0 = never expire. */
  cacheTtlHours: number;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export const DEFAULT_NPX_BIN = "npx -y @liustack/modlens@3.18.3";

export function getVisionBridgeSettings(): VisionBridgeSettings {
  const config = vscode.workspace.getConfiguration("zai");
  const vision = config.get<Record<string, unknown>>("visionBridge", {}) ?? {};

  return {
    enabled: readBool(vision, "enabled", false),
    bin: readString(vision, "bin", "modlens"),
    npxBypass: readBool(vision, "npxBypass", true),
    provider: readString(vision, "provider", ""),
    autoReuse: readStringArray(vision, "autoReuse", ["opencode", "codex"]),
    timeoutMs: clamp(readNumber(vision, "timeoutMs", 120000), 10_000, 300_000, 120_000),
    maxEvidenceChars: clamp(readNumber(vision, "maxEvidenceChars", 16000), 2000, 200_000, 16000),
    announce: readBool(vision, "announce", true),
    promptTemplate: readString(vision, "promptTemplate", ""),
    cacheTtlHours: clamp(readNumber(vision, "cacheTtlHours", 24), 0, 24 * 30, 24),
  };
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? [...new Set(items)] : [...fallback];
}

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function readBool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === "number" ? value : fallback;
}

export function isVisionBridgeEnabled(): boolean {
  return getVisionBridgeSettings().enabled;
}

// ---------------------------------------------------------------------------
// Shared bridge instance
// ---------------------------------------------------------------------------

let sharedBridge: VisionBridge | undefined;

/** Lazily-created singleton so the provider and commands share one cache. */
export function getVisionBridge(context: vscode.ExtensionContext): VisionBridge {
  if (!sharedBridge) {
    sharedBridge = new VisionBridge(context);
  }
  return sharedBridge;
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

interface SpawnCaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process was killed by our own timeout guard. */
  timedOut: boolean;
  /** Set when spawn itself failed (ENOENT, EACCES, ...). */
  spawnError?: string;
}

const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

async function spawnCapture(
  command: string,
  args: string[],
  options: { timeoutMs: number; token?: vscode.CancellationToken },
): Promise<SpawnCaptureResult> {
  return new Promise<SpawnCaptureResult>((resolve) => {
    const isWindows = process.platform === "win32";
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        // Windows needs the shell to resolve `.cmd` shims like npx/modlens.
        // All args are extension-controlled (hash file names, fixed flags)
        // except provider/prompt, which come from the user's own settings.
        shell: isWindows,
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (result: SpawnCaptureResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancelSubscription?.dispose();
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may already be gone.
      }
    }, options.timeoutMs);

    const cancelSubscription = options.token?.onCancellationRequested(() => {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURED_BYTES) {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CAPTURED_BYTES) {
        stderrChunks.push(chunk);
      }
    });

    child.on("error", (error) => {
      finish({
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        spawnError: error.message,
      });
    });

    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Vision bridge
// ---------------------------------------------------------------------------

interface ImageReadSuccess {
  ok: true;
  /** Serialized normalized ModlensResult — formatted per-request (index varies). */
  resultJson: string;
  provider?: string;
  cached: boolean;
  durationMs: number;
}

interface ImageReadFailure {
  ok: false;
  reason: string;
}

export type ImageReadResult = ImageReadSuccess | ImageReadFailure;

function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
  return (
    part instanceof vscode.LanguageModelDataPart &&
    typeof part.mimeType === "string" &&
    part.mimeType.startsWith("image/") &&
    !isInternalDataPart(part)
  );
}

function extensionForMime(mime: string): string {
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return ".jpg";
  }
  if (mime === "image/gif") {
    return ".gif";
  }
  if (mime === "image/webp") {
    return ".webp";
  }
  return ".png";
}

function abortError(): Error {
  return new DOMException("Request cancelled", "AbortError");
}

/** Filter the user's `autoReuse` allow-list to known agent harnesses. */
function allowlist(values: string[]): AgentHarness[] {
  const known = new Set<AgentHarness>(["opencode", "codex", "claude", "pi", "grok"]);
  return values.filter((value): value is AgentHarness => known.has(value as AgentHarness));
}

export class VisionBridge {
  private readonly cache = new EvidenceCache({ maxEntries: 64 });
  private readonly readSemaphore = pLimit(3);
  private outputChannel: vscode.OutputChannel | undefined;
  private sessionHintShown = false;
  private cacheDirPromise: Promise<string> | undefined;
  /** True once an engine has been confirmed usable this session. */
  private provisioned = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private log(message: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("Z.AI");
      this.context.subscriptions.push(this.outputChannel);
    }
    this.outputChannel.appendLine(`[${new Date().toISOString()}] [vision] ${message}`);
  }

  /** Resolve (and lazily create) the persistent cache directory. */
  private async cacheDir(): Promise<string> {
    if (!this.cacheDirPromise) {
      const dir = path.join(this.context.globalStorageUri.fsPath, "vision-cache");
      this.cacheDirPromise = mkdir(dir, { recursive: true }).then(() => dir);
    }
    return this.cacheDirPromise;
  }

  /**
   * Provider pre-pass: replace image DataParts with evidence TextParts.
   *
   * Never throws except cancellation (AbortError) — any other failure keeps
   * the original messages (images are then dropped downstream exactly as
   * today, so the chat still works).
   */
  async processMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    token: vscode.CancellationToken,
    progress?: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<readonly vscode.LanguageModelChatRequestMessage[]> {
    const settings = getVisionBridgeSettings();

    try {
      // Pass 1 — collect unique image reads, deduped by cache key.
      const reads = new Map<string, Promise<ImageReadResult>>();
      let totalImages = 0;
      for (const message of messages) {
        for (const part of message.content) {
          if (!isImagePart(part)) {
            continue;
          }
          totalImages++;
          const key = evidenceCacheKey(part.data, settings.promptTemplate || undefined);
          if (!reads.has(key)) {
            const read = this.readImage(part.data, part.mimeType, key, token).catch(
              (error): ImageReadResult => ({
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              }),
            );
            reads.set(key, read);
          }
        }
      }

      if (totalImages === 0) {
        return messages;
      }

      if (token.isCancellationRequested) {
        throw abortError();
      }

      // Announce only when at least one image is not already in the memory
      // cache — pure cache-hit turns stay silent.
      const anyFreshRead = Array.from(reads.keys()).some((key) => !this.cache.peek(key));
      if (settings.announce && anyFreshRead && progress) {
        progress.report(
          new vscode.LanguageModelTextPart(
            `👁 Reading ${totalImages} attached image(s) via the modlens vision bridge — the first read can take 5–45s…\n\n`,
          ),
        );
      }

      const results = new Map<string, ImageReadResult>();
      await Promise.all(
        Array.from(reads.entries()).map(async ([key, read]) => {
          results.set(key, await read);
        }),
      );

      if (token.isCancellationRequested) {
        throw abortError();
      }

      // Pass 2 — rebuild messages, replacing each image part in place.
      let index = 0;
      const rebuilt = messages.map((message) => {
        if (!message.content.some((part) => isImagePart(part))) {
          return message;
        }

        const content = message.content.map((part) => {
          if (!isImagePart(part)) {
            return part;
          }
          index++;
          const key = evidenceCacheKey(part.data, settings.promptTemplate || undefined);
          const result = results.get(key);
          return new vscode.LanguageModelTextPart(
            this.renderReplacement(result, index, settings, key),
          );
        });

        return { role: message.role, name: message.name, content };
      });

      this.log(
        `processMessages: ${totalImages} image part(s), ${reads.size} unique, ` +
          `${Array.from(results.values()).filter((r) => r.ok && !r.cached).length} fresh read(s), ` +
          `${Array.from(results.values()).filter((r) => !r.ok).length} failed`,
      );

      return rebuilt;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      // Unexpected bridge failure: log, degrade to today's behavior.
      this.log(`processMessages failed, passing original messages through: ${String(error)}`);
      return messages;
    }
  }

  private renderReplacement(
    result: ImageReadResult | undefined,
    index: number,
    settings: VisionBridgeSettings,
    key: string,
  ): string {
    if (!result || !result.ok) {
      const reason = result && !result.ok ? result.reason : "no result";
      // If the failure is a missing binary and auto-provision is enabled, the
      // engine is being installed in the background — tell the model to ask
      // for a retry rather than reporting a hard failure.
      if (this.isProvisioningFailure(reason)) {
        return this.renderNeedsProvision(index);
      }
      this.maybeShowSetupHint(reason);
      return (
        `[Image ${index}: the user attached an image here, but the vision bridge could not read it ` +
        `(${reason}). Tell the user their image could not be analyzed and suggest running the ` +
        `"Z.AI: Setup Vision Bridge" command.]`
      );
    }

    try {
      const parsed = JSON.parse(result.resultJson) as Parameters<typeof formatEvidenceBlock>[0];
      return formatEvidenceBlock(
        parsed,
        {
          index,
          image: evidenceCacheFileName(key),
          ...(result.provider ? { engine: result.provider } : {}),
        },
        { maxChars: settings.maxEvidenceChars },
      );
    } catch (error) {
      this.log(`evidence formatting failed for ${key}: ${String(error)}`);
      return (
        `[Image ${index}: attached and read, but the evidence could not be formatted ` +
        `(${error instanceof Error ? error.message : String(error)}).]`
      );
    }
  }

  /** Read one image: memory cache → persistent sidecar → modlens spawn. */
  private async readImage(
    bytes: Uint8Array,
    mime: string,
    key: string,
    token: vscode.CancellationToken,
  ): Promise<ImageReadResult> {
    if (token.isCancellationRequested) {
      throw abortError();
    }

    const settings = getVisionBridgeSettings();
    const startedAt = Date.now();

    // Tier 1: memory.
    const memoryHit = this.cache.get(key);
    if (memoryHit) {
      return {
        ok: true,
        resultJson: memoryHit.evidence,
        provider: memoryHit.provider,
        cached: true,
        durationMs: Date.now() - startedAt,
      };
    }

    const fileName = evidenceCacheFileName(key);
    const dir = await this.cacheDir();
    const sidecarPath = path.join(dir, `${fileName}.json`);
    const imagePath = path.join(dir, `${fileName}${extensionForMime(mime)}`);

    // Tier 2: persistent sidecar.
    const persisted = await this.loadSidecar(sidecarPath, settings.cacheTtlHours);
    if (persisted) {
      this.cache.set(key, persisted);
      this.log(`read ${fileName}: persistent cache hit`);
      return {
        ok: true,
        resultJson: persisted.evidence,
        provider: persisted.provider,
        cached: true,
        durationMs: Date.now() - startedAt,
      };
    }

    // Tier 3: modlens (bounded to 3 concurrent spawns).
    // pLimit wraps fn as Promise<unknown> — restore the discriminated union.
    const outcome = (await this.readSemaphore(() =>
      this.runModlens(imagePath, bytes, key, settings, token),
    )) as Awaited<ReturnType<VisionBridge["runModlens"]>>;

    if (!outcome.ok) {
      this.log(`read ${fileName}: FAILED — ${outcome.reason}`);
      return { ok: false, reason: outcome.reason };
    }

    const output = outcome.output;
    const provider = describeModlensEngine(output);
    const resultJson = JSON.stringify(output.result);

    const entry: EvidenceCacheEntry = { evidence: resultJson, provider, cachedAt: Date.now() };
    this.cache.set(key, entry);
    await this.saveSidecar(sidecarPath, entry);

    const warnings = output.meta?.warnings?.length ? ` warnings=${JSON.stringify(output.meta.warnings)}` : "";
    this.log(
      `read ${fileName}: ok engine=${provider} durationMs=${Date.now() - startedAt}${warnings}`,
    );

    return {
      ok: true,
      resultJson,
      provider,
      cached: false,
      durationMs: Date.now() - startedAt,
    };
  }

  private async runModlens(
    imagePath: string,
    bytes: Uint8Array,
    key: string,
    settings: VisionBridgeSettings,
    token: vscode.CancellationToken,
  ): Promise<{ ok: true; output: ModlensOutput } | { ok: false; reason: string }> {
    try {
      // The image file is written per hash, so repeated runs reuse the same
      // path and a crashed run leaves at worst a stale-but-identical copy.
      await writeFile(imagePath, Buffer.from(bytes));

      const { command, baseArgs } = resolveBinCommand(settings.bin);
      const args = [
        ...baseArgs,
        ...buildModlensAnalyzeArgs({
          input: imagePath,
          provider: settings.provider || undefined,
          prompt: settings.promptTemplate || undefined,
          timeoutMs: settings.timeoutMs,
        }),
      ];

      // Our own guard fires slightly after modlens' internal --timeout so the
      // CLI's own timeout error (with provider detail) wins when it works.
      const graceMs = settings.timeoutMs + 15_000;
      const first = await this.spawnModlens(command, args, graceMs, token);
      if (!first.spawnError) {
        return this.materialize(first);
      }

      // Binary missing (ENOENT) — auto-provision via npx once, then retry.
      this.log(`modlens binary not runnable (${first.spawnError}); attempting npx bypass`);
      if (!(settings.npxBypass && (await this.ensureEngine(settings, token)))) {
        return { ok: false, reason: `could not run modlens (${first.spawnError})` };
      }
      const npxCommand = resolveBinCommand(DEFAULT_NPX_BIN);
      const retried = await this.spawnModlens(
        npxCommand.command,
        [...npxCommand.baseArgs, ...args],
        graceMs,
        token,
      );
      return this.materialize(retried);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async spawnModlens(
    command: string,
    args: string[],
    graceMs: number,
    token: vscode.CancellationToken,
  ): Promise<SpawnCaptureResult> {
    this.log(`spawning ${command} ${args.join(" ")}`);
    const buffered = await spawnCapture(command, args, { timeoutMs: graceMs, token });
    if (buffered.spawnError) {
      return buffered;
    }
    if (buffered.timedOut) {
      // Re-surface as a non-spawn error so materialize() reports a clear reason.
      return {
        ...buffered,
        code: null,
        stderr: `modlens timed out after ${Math.round(graceMs / 1000)}s`,
      };
    }
    return buffered;
  }

  private materialize(
    result: SpawnCaptureResult,
  ): { ok: true; output: ModlensOutput } | { ok: false; reason: string } {
    if (result.spawnError) {
      return { ok: false, reason: `could not run modlens (${result.spawnError})` };
    }
    if (result.timedOut) {
      return { ok: false, reason: result.stderr || "modlens timed out" };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        reason: extractFailureReason(result.stdout, result.stderr, result.code),
      };
    }
    const output = parseModlensOutput(result.stdout);
    if (!output) {
      return { ok: false, reason: "modlens produced no parsable result on stdout" };
    }
    return { ok: true, output };
  }

  /**
   * Auto-provision a vision engine. Steps:
   *   1. Send modlens through npx (which fetches the package on first use) to
   *      run `doctor --json`, so even a machine with no global modlens can be
   *      inspected.
   *   2. If a vision engine is already usable (API key set, or a reusable CLI
   *      granted), enable the bridge and return true.
   *   3. Otherwise, if a discoverable agent CLI (codex/opencode) holds vision
   *      and the user's `autoReuse` allow-list permits it, grant
   *      `reuse.<harness> true` (a one-line change written by npx-spawned
   *      modlens) and re-run doctor to confirm. This is the "seamless, no
   *      API key" path.
   * Returns true only when a usable engine exists afterwards.
   */
  private async ensureEngine(settings: VisionBridgeSettings, token: vscode.CancellationToken): Promise<boolean> {
    if (this.provisioned) {
      return true;
    }
    const npxCommand = resolveBinCommand(DEFAULT_NPX_BIN);

    const doctorRun = await this.spawnModlens(
      npxCommand.command,
      [...npxCommand.baseArgs, "doctor", "--json"],
      90_000,
      token,
    );
    if (token.isCancellationRequested) {
      return false;
    }
    const doctor = doctorRun.code === 0 ? parseModlensDoctor(doctorRun.stdout) : undefined;

    if (doctor && doctor.hasUsableEngine) {
      this.provisioned = true;
      this.log("engine already usable — vision bridge ready");
      return true;
    }

    const target = doctor ? pickReuseTarget(doctor, allowlist(settings.autoReuse)) : undefined;
    if (!target) {
      this.log(`no auto-provisionable engine: ${doctor ? describeNoEngine(doctor) : "doctor unavailable"}`);
      return false;
    }

    this.log(`auto-granting reuse.${target} (user allow-list: ${settings.autoReuse.join(", ")})`);
    const grant = await this.spawnModlens(
      npxCommand.command,
      [...npxCommand.baseArgs, "config", "set", `reuse.${target}`, "true"],
      60_000,
      token,
    );
    if (grant.code !== 0) {
      this.log(`reuse.${target} grant failed: ${extractFailureReason(grant.stdout, grant.stderr, grant.code)}`);
      return false;
    }

    const recheck = await this.spawnModlens(
      npxCommand.command,
      [...npxCommand.baseArgs, "doctor", "--json"],
      90_000,
      token,
    );
    const confirmed = recheck.code === 0 ? parseModlensDoctor(recheck.stdout) : undefined;
    if (confirmed?.hasUsableEngine) {
      this.provisioned = true;
      this.log(`engine provisioned via reuse.${target}`);
      return true;
    }

    this.log(`reuse.${target} granted but still no usable engine: ${confirmed ? describeNoEngine(confirmed) : "recheck unavailable"}`);
    return false;
  }

  /** Render a short ability-checking notice instead of a full failure when auto-provision is pending. */
  private renderNeedsProvision(index: number): string {
    return (
      `[Image ${index}: could not be read yet — the vision bridge is installing/checking its engine ` +
      `in the background. Please send your follow-up message again and the image will be described.]`
    );
  }

  private isProvisioningFailure(reason: string): boolean {
    return (
      getVisionBridgeSettings().npxBypass &&
      /ENOENT|not found|could not run|spawn|EACCES/i.test(reason)
    );
  }

  private maybeShowSetupHint(reason: string): void {
    if (this.sessionHintShown) {
      return;
    }
    const looksLikeMissingBinary =
      /ENOENT|not found|could not run|spawn|EACCES/i.test(reason);
    if (!looksLikeMissingBinary) {
      return;
    }
    this.sessionHintShown = true;
    void vscode.window
      .showWarningMessage(
        "Z.AI: The modlens vision bridge is enabled but modlens could not run. Images will be described as unread until it is installed.",
        "Set Up",
      )
      .then((choice) => {
        if (choice === "Set Up") {
          void vscode.commands.executeCommand("zai.vision.setup");
        }
      });
  }

  private async loadSidecar(
    sidecarPath: string,
    ttlHours: number,
  ): Promise<EvidenceCacheEntry | undefined> {
    try {
      const raw = await readFile(sidecarPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const evidence = parsed.evidence;
      if (typeof evidence !== "string" || evidence.length === 0) {
        return undefined;
      }
      const cachedAt = typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0;
      if (ttlHours > 0 && Date.now() - cachedAt > ttlHours * 3_600_000) {
        return undefined;
      }
      const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
      return { evidence, ...(provider !== undefined ? { provider } : {}), cachedAt };
    } catch {
      // Missing or corrupt sidecar = cold read.
      return undefined;
    }
  }

  private async saveSidecar(sidecarPath: string, entry: EvidenceCacheEntry): Promise<void> {
    try {
      await writeFile(sidecarPath, JSON.stringify(entry), "utf8");
    } catch (error) {
      // Persistence is an optimization, never a requirement.
      this.log(`sidecar write failed (${String(error)}) — memory cache still holds the entry`);
    }
  }

  /** Summary for the `Z.AI: Vision Bridge Status` command. */
  async statusSummary(): Promise<{
    settings: VisionBridgeSettings;
    memory: ReturnType<EvidenceCache["stats"]>;
    persistentEntries: number;
    persistentBytes: number;
  }> {
    let persistentEntries = 0;
    let persistentBytes = 0;
    try {
      const dir = await this.cacheDir();
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        persistentEntries++;
        try {
          const info = await stat(path.join(dir, file));
          persistentBytes += info.size;
        } catch {
          // File removed between readdir and stat — ignore.
        }
      }
    } catch {
      // No cache dir yet.
    }

    return {
      settings: getVisionBridgeSettings(),
      memory: this.cache.stats(),
      persistentEntries,
      persistentBytes,
    };
  }
}

// ---------------------------------------------------------------------------
// Commands (Phase 1 minimal implementations; richer UX lands in Phase 2)
// ---------------------------------------------------------------------------

export async function runVisionSetup(
  context: vscode.ExtensionContext,
  notifyModelsChanged: () => void,
): Promise<void> {
  const settings = getVisionBridgeSettings();
  // The setup flow always probes through npx so it works even when the user
  // has no global modlens yet — npx fetches the pinned package on first use.
  const npxCommand = resolveBinCommand(DEFAULT_NPX_BIN);

  const status = vscode.window.setStatusBarMessage("$(loading~spin) Checking modlens…");
  let version = "";
  let versionError = "";
  let doctorJson = "";
  try {
    const versionResult = await spawnCapture(npxCommand.command, [...npxCommand.baseArgs, "--version"], { timeoutMs: 60_000 });
    if (versionResult.spawnError) {
      versionError = versionResult.spawnError;
    } else if (versionResult.code === 0) {
      version = versionResult.stdout.trim();
    } else {
      versionError = extractFailureReason(versionResult.stdout, versionResult.stderr, versionResult.code);
    }

    const doctorResult = await spawnCapture(npxCommand.command, [...npxCommand.baseArgs, "doctor", "--json"], { timeoutMs: 120_000 });
    doctorJson = (doctorResult.stdout || doctorResult.stderr).trim().slice(0, 8000);
  } finally {
    status.dispose();
  }

  const doctor = parseModlensDoctor(doctorJson);
  const readyText = doctor
    ? doctor.hasUsableEngine
      ? `**ready** — ${describeNoEngine(doctor)}`
      : `waiting — ${describeNoEngine(doctor)}`
    : "unknown";

  const lines: string[] = ["# Z.AI Vision Bridge (modlens)", ""];
  lines.push(`- Setting: **${settings.enabled ? "enabled" : "disabled"}**`);
  lines.push(`- Binary: \`${settings.bin}\` (npx fallback: \`${DEFAULT_NPX_BIN}\`)`);
  lines.push(version ? `- modlens version: \`${version}\`` : `- modlens: not resolved — ${versionError || "could not fetch via npx"}`);
  lines.push(`- Engine: ${readyText}`);
  if (settings.provider) {
    lines.push(`- Pinned provider: \`${settings.provider}\``);
  }
  if (settings.autoReuse.length) {
    lines.push(`- Auto-reuse allow-list: ${settings.autoReuse.join(", ")}`);
    if (doctor?.discoveredCli.length) {
      lines.push(`- Reusable CLIs found: ${doctor.discoveredCli.map((c) => `${c.harness} (${c.cliPath})`).join(", ")}`);
    }
  }
  lines.push("");
  lines.push("## Doctor");
  lines.push(doctorJson ? "```json\n" + doctorJson + "\n```" : "_skipped (modlens not resolvable)_");
  lines.push("");
  lines.push("## Installing modlens");
  lines.push("The bridge auto-fetches modlens through npx on first use, so a global install is optional. To install globally anyway:");
  lines.push("```bash");
  lines.push("npm install -g @liustack/modlens@3.18.3   # pinned — avoids pnpm/npm latest-gate issues");
  lines.push("```");
  lines.push("");
  lines.push("## Engine");
  lines.push("- **Zero-key**: the bridge auto-grants a reusable CLI (opencode/codex) that already has vision — see `zai.visionBridge.autoReuse`.");
  lines.push("- **Free API key** (recommended if no reusable CLI):");
  lines.push("```bash");
  lines.push("modlens config set gemini-api.apiKey   # prompts with hidden echo; free key: https://aistudio.google.com");
  lines.push("```");
  lines.push("- Zero-signup alternative: the free Antigravity CLI (`agy`) needs no key at all.");
  lines.push("");
  lines.push("_Full evaluation: `doc/modlens-vision-bridge-evaluation.md`_");

  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

  if (!settings.enabled) {
    const enable = await vscode.window.showInformationMessage(
      "Z.AI: Enable the vision bridge now? All GLM models will advertise image input and convert attached images to text evidence at request time.",
      "Enable Vision Bridge",
    );
    if (enable === "Enable Vision Bridge") {
      await vscode.workspace
        .getConfiguration("zai")
        .update("visionBridge.enabled", true, vscode.ConfigurationTarget.Global);
      notifyModelsChanged();
      const reload = await vscode.window.showInformationMessage(
        "Z.AI: Vision bridge enabled. Reload the window so the model picker refreshes image-input capabilities.",
        "Reload Window",
      );
      if (reload === "Reload Window") {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  }
}

export async function runVisionStatus(context: vscode.ExtensionContext): Promise<void> {
  const bridge = getVisionBridge(context);
  const summary = await bridge.statusSummary();
  const { settings, memory, persistentEntries, persistentBytes } = summary;

  const lines: string[] = ["# Z.AI Vision Bridge status", ""];
  lines.push(`- Enabled: **${settings.enabled ? "yes" : "no"}**`);
  lines.push(`- Binary: \`${settings.bin}\``);
  lines.push(`- Provider: ${settings.provider ? `\`${settings.provider}\`` : "_modlens failover chain_"}`);
  lines.push(`- Timeout: ${settings.timeoutMs} ms`);
  lines.push(`- Max evidence chars: ${settings.maxEvidenceChars}`);
  lines.push(`- Cache TTL: ${settings.cacheTtlHours === 0 ? "never expires" : `${settings.cacheTtlHours} h`}`);
  lines.push("");
  lines.push("## Cache");
  lines.push(`- Memory tier: ${memory.size} entr${memory.size === 1 ? "y" : "ies"}, ${memory.hits} hit(s), ${memory.misses} miss(es), ${memory.evictions} eviction(s)`);
  lines.push(`- Persistent tier: ${persistentEntries} entr${persistentEntries === 1 ? "y" : "ies"}, ~${Math.round(persistentBytes / 1024)} KB`);

  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}
