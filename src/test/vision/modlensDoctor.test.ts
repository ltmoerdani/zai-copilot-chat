/**
 * Unit tests for the modlens doctor parser and reuse-target selection.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  describeNoEngine,
  parseModlensDoctor,
  pickReuseTarget,
} from "../../vision/modlensDoctor.js";

const DOCTOR_WITH_REUSE = JSON.stringify({
  node: { version: "v22.23.2", minimum: "22.19", meetsMinimum: true },
  providers: [
    { name: "gemini-api", kind: "api", ready: true, status: "ready", detail: "apiKey: file" },
    { name: "antigravity-cli", kind: "subprocess", ready: false, status: "missing", detail: "agy not on PATH" },
    { name: "openai", kind: "api", ready: false, status: "missing", detail: "missing: baseUrl, apiKey, model" },
  ],
  reuse: {
    decisions: { claude: "granted", codex: "not asked", opencode: "not asked", pi: "not asked", grok: "not asked" },
    probes: [
      { harness: "claude-code", cliFound: true, cliPath: "/Users/x/.local/bin/claude", visionModels: ["anthropic/*"] },
      { harness: "opencode", cliFound: true, cliPath: "/opt/homebrew/bin/opencode", visionModels: ["deepseek/*"] },
    ],
  },
});

test("parseModlensDoctor: parses ready providers and reuse state", () => {
  const doctor = parseModlensDoctor(DOCTOR_WITH_REUSE);
  assert.ok(doctor);
  assert.deepEqual(doctor.readyProviders, ["gemini-api"]);
  assert.equal(doctor.hasUsableEngine, true);
  assert.deepEqual(doctor.grantedHarnesses, ["claude"]);
  assert.deepEqual(doctor.discoveredCli, [
    { harness: "claude", cliPath: "/Users/x/.local/bin/claude" },
    { harness: "opencode", cliPath: "/opt/homebrew/bin/opencode" },
  ]);
});

test("parseModlensDoctor: rejects non-JSON and payloads without providers", () => {
  assert.equal(parseModlensDoctor(""), undefined);
  assert.equal(parseModlensDoctor("garbage"), undefined);
  assert.equal(parseModlensDoctor(JSON.stringify({ node: {} })), undefined);
  assert.equal(parseModlensDoctor(JSON.stringify({ providers: "nope" })), undefined);
});

test("parseModlensDoctor: tolerates missing reuse section", () => {
  const doctor = parseModlensDoctor(JSON.stringify({ providers: [{ name: "gemini-api", ready: true }] }));
  assert.ok(doctor);
  assert.deepEqual(doctor.grantedHarnesses, []);
  assert.deepEqual(doctor.discoveredCli, []);
  assert.equal(doctor.hasUsableEngine, true);
});

test("parseModlensDoctor: no engine when nothing ready or granted", () => {
  const doctor = parseModlensDoctor(
    JSON.stringify({
      providers: [
        { name: "gemini-api", ready: false, detail: "missing: apiKey" },
        { name: "antigravity-cli", ready: false, detail: "agy not on PATH" },
      ],
      reuse: { decisions: { codex: "not asked", opencode: "not asked" }, probes: [] },
    }),
  );
  assert.ok(doctor);
  assert.equal(doctor.hasUsableEngine, false);
  assert.deepEqual(doctor.readyProviders, []);
});

test("pickReuseTarget: prefers an already-granted harness with a found CLI", () => {
  const doctor = parseModlensDoctor(DOCTOR_WITH_REUSE);
  assert.ok(doctor);
  // claude is granted and its CLI is found → chosen even though opencode is
  // also discoverable.
  assert.equal(pickReuseTarget(doctor, ["opencode", "codex"]), "claude");
});

test("pickReuseTarget: falls back to first allowed discovered CLI", () => {
  const doctor = parseModlensDoctor(
    JSON.stringify({
      providers: [],
      reuse: {
        decisions: { codex: "not asked", opencode: "not asked" },
        probes: [
          { harness: "opencode", cliFound: true, cliPath: "/opt/homebrew/bin/opencode" },
          { harness: "codex", cliFound: true, cliPath: "/Users/x/.local/bin/codex" },
        ],
      },
    }),
  );
  assert.ok(doctor);
  assert.equal(pickReuseTarget(doctor, ["opencode", "codex"]), "opencode");
  assert.equal(pickReuseTarget(doctor, ["codex"]), "codex");
});

test("pickReuseTarget: respects the allow-list (never auto-grants outside it)", () => {
  const doctor = parseModlensDoctor(
    JSON.stringify({
      providers: [],
      reuse: {
        decisions: {},
        probes: [{ harness: "opencode", cliFound: true, cliPath: "/opt/homebrew/bin/opencode" }],
      },
    }),
  );
  assert.ok(doctor);
  assert.equal(pickReuseTarget(doctor, ["codex"]), undefined);
  assert.equal(pickReuseTarget(doctor, []), undefined);
});

test("pickReuseTarget: undefined when nothing discovered", () => {
  const doctor = parseModlensDoctor(JSON.stringify({ providers: [], reuse: { decisions: {}, probes: [] } }));
  assert.ok(doctor);
  assert.equal(pickReuseTarget(doctor, ["opencode", "codex"]), undefined);
});

test("describeNoEngine: summarizes providers and discovered CLIs", () => {
  const doctor = parseModlensDoctor(
    JSON.stringify({
      providers: [{ name: "gemini-api", ready: false, detail: "missing: apiKey" }],
      reuse: { decisions: {}, probes: [{ harness: "opencode", cliFound: true, cliPath: "/x" }] },
    }),
  );
  assert.ok(doctor);
  const text = describeNoEngine(doctor);
  assert.match(text, /gemini-api/);
  assert.match(text, /missing: apiKey/);
  assert.match(text, /opencode/);
});
