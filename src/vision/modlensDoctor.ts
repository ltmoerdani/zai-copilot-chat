/**
 * Pure parser for `modlens doctor --json` output — no `vscode` import.
 *
 * modlens' doctor report lists which vision providers are ready, which local
 * agent CLIs (codex, opencode, pi, grok, claude) hold reusable vision, and the
 * current config state. We parse enough of it to auto-provision an engine:
 * see which providers are ready, which reusable CLIs are discovered, and what
 * the current reuse grant decisions are.
 *
 * The exact doctor schema is not a stable public API contract, so parsing is
 * deliberately defensive: unknown fields ignored, every lookup fails open.
 *
 * Doctor shape (verified from a real run):
 * {
 *   node: { version, minimum, meetsMinimum },
 *   providers: [
 *     { name, kind: "api"|"subprocess", ready: bool, status, detail, fix,
 *       apiKey?: { present, source } }
 *   ],
 *   reuse?: { decisions: Record<harness, "granted"|"denied"|"not asked">,
 *             probes: [{ harness, cliFound, cliPath, visionModels }] }
 * }
 */

export const AGENT_HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "grok",
] as const;

export type AgentHarness = (typeof AGENT_HARNESSES)[number];

export interface DoctorState {
  /** Provider names currently ready (e.g. ["gemini-api"]). */
  readyProviders: string[];
  /** Provider names present but not ready, with a short reason. */
  unreadyProviders: Array<{ name: string; detail: string }>;
  /** Local agent CLIs discovered to hold vision. */
  discoveredCli: Array<{ harness: string; cliPath: string }>;
  /** Harnesses the user already granted (reuse.<harness> = true). */
  grantedHarnesses: AgentHarness[];
  /** True when a usable engine is ready to read images right now. */
  hasUsableEngine: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isAgentHarness(value: string): value is AgentHarness {
  return (AGENT_HARNESSES as readonly string[]).includes(value);
}

/**
 * Parse a raw `modlens doctor --json` string. Returns `undefined` when the
 * payload is not a JSON object with a `providers` array.
 */
export function parseModlensDoctor(raw: string): DoctorState | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.providers)) {
    return undefined;
  }

  const readyProviders: string[] = [];
  const unreadyProviders: Array<{ name: string; detail: string }> = [];
  for (const provider of asArray(parsed.providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    const name = typeof provider.name === "string" ? provider.name : "";
    if (!name) {
      continue;
    }
    const ready = provider.ready === true;
    if (ready) {
      readyProviders.push(name);
    } else {
      unreadyProviders.push({
        name,
        detail: typeof provider.detail === "string" ? provider.detail : "",
      });
    }
  }

  const grantedHarnesses: AgentHarness[] = [];
  const reuse = parsed.reuse;
  if (isRecord(reuse) && isRecord(reuse.decisions)) {
    for (const [harness, decision] of Object.entries(reuse.decisions)) {
      if (decision === "granted" && isAgentHarness(harness)) {
        grantedHarnesses.push(harness);
      }
    }
  }

  const discoveredCli: Array<{ harness: string; cliPath: string }> = [];
  for (const probe of asArray(isRecord(reuse) ? reuse.probes : undefined)) {
    if (!isRecord(probe)) {
      continue;
    }
    // modlens reports the probe harness as e.g. "claude-code" but the reuse
    // grant key is "claude" — normalize so both sides use the grant-key naming.
    const rawHarness = typeof probe.harness === "string" ? probe.harness : "";
    const harness = rawHarness === "claude-code" ? "claude" : rawHarness;
    const cliPath = typeof probe.cliPath === "string" ? probe.cliPath : "";
    if (harness && probe.cliFound === true && cliPath) {
      discoveredCli.push({ harness, cliPath });
    }
  }

  const hasUsableEngine = readyProviders.length > 0 || grantedHarnesses.length > 0;

  return { readyProviders, unreadyProviders, discoveredCli, grantedHarnesses, hasUsableEngine };
}

/**
 * Pick a reuse target: prefer a harness the user already granted, else the
 * first discovered CLI we are allowed to auto-grant. Returns `undefined` when
 * nothing reusable is present.
 *
 * The auto-grant order matches safety + usefulness: opencode is a local agent
 * like codex; claude is only auto-granted if it is ready (it rides a paid
 * subscription, so we prefer the explicitly configurable ones first).
 */
export function pickReuseTarget(
  doctor: DoctorState,
  autoGrantAllowed: AgentHarness[],
): AgentHarness | undefined {
  // Already-granted harnesses must only appear if a matching CLI is still found.
  for (const harness of doctor.grantedHarnesses) {
    if (doctor.discoveredCli.some((cli) => cli.harness === harness)) {
      return harness;
    }
  }

  const allowed = new Set<AgentHarness>(autoGrantAllowed);
  for (const cli of doctor.discoveredCli) {
    const harness = cli.harness;
    if (isAgentHarness(harness) && allowed.has(harness)) {
      return harness;
    }
  }

  return undefined;
}

/** Human-readable, non-sensitive reason why no engine is usable. */
export function describeNoEngine(doctor: DoctorState): string {
  if (doctor.readyProviders.length) {
    return `ready: ${doctor.readyProviders.join(", ")}`;
  }
  const reasons = doctor.unreadyProviders.map((p) => `${p.name} (${p.detail})`);
  const discovered = doctor.discoveredCli.map((c) => c.harness).join(", ");
  return [
    reasons.length ? `no provider ready: ${reasons.join("; ")}` : "no provider ready",
    discovered ? `reusable CLIs found: ${discovered}` : "no reusable CLI found",
  ].join(" — ");
}