/**
 * Unit tests for the modlens CLI argv builder.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_MODLENS_BIN,
  buildModlensAnalyzeArgs,
  resolveBinCommand,
} from "../../vision/modlensArgs.js";

test("resolveBinCommand: empty/undefined falls back to bare modlens", () => {
  assert.deepEqual(resolveBinCommand(undefined), { command: DEFAULT_MODLENS_BIN, baseArgs: [] });
  assert.deepEqual(resolveBinCommand(""), { command: DEFAULT_MODLENS_BIN, baseArgs: [] });
  assert.deepEqual(resolveBinCommand("   "), { command: DEFAULT_MODLENS_BIN, baseArgs: [] });
});

test("resolveBinCommand: bare command has no base args", () => {
  assert.deepEqual(resolveBinCommand("modlens"), { command: "modlens", baseArgs: [] });
  assert.deepEqual(resolveBinCommand("/usr/local/bin/modlens"), {
    command: "/usr/local/bin/modlens",
    baseArgs: [],
  });
});

test("resolveBinCommand: npx-style command splits into base args", () => {
  assert.deepEqual(resolveBinCommand("npx -y @liustack/modlens@3.18.3"), {
    command: "npx",
    baseArgs: ["-y", "@liustack/modlens@3.18.3"],
  });
});

test("resolveBinCommand: collapses repeated whitespace", () => {
  assert.deepEqual(resolveBinCommand("  npx   -y   pkg  "), {
    command: "npx",
    baseArgs: ["-y", "pkg"],
  });
});

test("buildModlensAnalyzeArgs: minimal invocation is just -i input", () => {
  assert.deepEqual(buildModlensAnalyzeArgs({ input: "/tmp/a.png" }), ["-i", "/tmp/a.png"]);
});

test("buildModlensAnalyzeArgs: all options included in manual order", () => {
  assert.deepEqual(
    buildModlensAnalyzeArgs({
      input: "/tmp/a.png",
      provider: "gemini-api",
      model: "gemini-3.6-flash",
      prompt: "focus on axes",
      timeoutMs: 90000,
    }),
    ["-i", "/tmp/a.png", "-p", "gemini-api", "-m", "gemini-3.6-flash", "--prompt", "focus on axes", "--timeout", "90000"],
  );
});

test("buildModlensAnalyzeArgs: empty-string options are omitted", () => {
  assert.deepEqual(
    buildModlensAnalyzeArgs({ input: "x.png", provider: "", model: "", prompt: "" }),
    ["-i", "x.png"],
  );
});

test("buildModlensAnalyzeArgs: invalid timeouts are omitted", () => {
  assert.deepEqual(buildModlensAnalyzeArgs({ input: "x.png", timeoutMs: 0 }), ["-i", "x.png"]);
  assert.deepEqual(buildModlensAnalyzeArgs({ input: "x.png", timeoutMs: Number.NaN }), ["-i", "x.png"]);
  assert.deepEqual(buildModlensAnalyzeArgs({ input: "x.png", timeoutMs: -5 }), ["-i", "x.png"]);
});

test("buildModlensAnalyzeArgs: fractional timeouts are floored", () => {
  assert.deepEqual(buildModlensAnalyzeArgs({ input: "x.png", timeoutMs: 120000.9 }), [
    "-i",
    "x.png",
    "--timeout",
    "120000",
  ]);
});
