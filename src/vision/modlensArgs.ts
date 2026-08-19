/**
 * Pure builder for modlens CLI argv — no `vscode` import, unit-testable.
 *
 * CLI contract (modlens 3.x, `modlens analyze` is the default command):
 *   modlens -i <path|url> [-p <provider>] [-m <model>] [--prompt <text>]
 *           [--timeout <ms>] [-o <file>]
 * Docs: https://github.com/liustack/modlens/blob/main/docs/cli.md
 */

export interface ModlensAnalyzeArgs {
  /** Image to analyze — absolute file path or URL (required). */
  input: string;
  /** Pin exactly one provider (`gemini-api`, `openai`, `antigravity-cli`, ...). Unset = failover chain. */
  provider?: string;
  /** Provider model. Unset = provider default. */
  model?: string;
  /** Extra focus text forwarded to the vision engine. */
  prompt?: string;
  /** Per-read provider timeout in ms. modlens default is 180000. */
  timeoutMs?: number;
}

export interface ResolvedBinCommand {
  /** Executable to spawn. */
  command: string;
  /** Static leading args (e.g. `-y @liustack/modlens@3.18.3` for an npx-style bin). */
  baseArgs: string[];
}

export const DEFAULT_MODLENS_BIN = "modlens";

/**
 * Resolve the `zai.visionBridge.bin` setting into a spawnable command.
 *
 * Accepts either a bare executable (`modlens`, `/usr/local/bin/modlens`) or a
 * command with static leading arguments (`npx -y @liustack/modlens@3.18.3`).
 * The latter is split on whitespace; values with quoted arguments are not
 * supported — document a wrapper script for those.
 */
export function resolveBinCommand(bin: string | undefined): ResolvedBinCommand {
  const trimmed = (bin ?? "").trim();
  if (!trimmed) {
    return { command: DEFAULT_MODLENS_BIN, baseArgs: [] };
  }
  const parts = trimmed.split(/\s+/);
  return { command: parts[0], baseArgs: parts.slice(1) };
}

/**
 * Build the argv (without the executable/base args) for `modlens analyze`.
 * Only truthy optional flags are included; ordering matches the CLI manual.
 */
export function buildModlensAnalyzeArgs(options: ModlensAnalyzeArgs): string[] {
  const args: string[] = ["-i", options.input];

  if (options.provider) {
    args.push("-p", options.provider);
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.prompt) {
    args.push("--prompt", options.prompt);
  }
  if (
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
  ) {
    args.push("--timeout", String(Math.floor(options.timeoutMs)));
  }

  return args;
}
