/**
 * Unit tests for modlens output parsing and evidence formatting.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EVIDENCE_CLOSE_TAG,
  EVIDENCE_OPEN_TAG,
  extractFailureReason,
  formatEvidenceBlock,
  parseModlensOutput,
} from "../../vision/modlensOutput.js";

/** Representative valid modlens v2 output (from docs/output-schema.md). */
const VALID_OUTPUT = JSON.stringify({
  image: "/tmp/x.png",
  provider: "gemini-api",
  result: {
    summary: "A workflow diagram with four nodes connected by labeled arrows.",
    ocr: {
      full_text: "/shaping\nBEFORE YOU BUILD\nship less, learn more",
      lines: [{ text: "/shaping" }, { text: "BEFORE YOU BUILD", language: "en" }],
    },
    layout: {
      regions: [
        { type: "title", reading_order: 2, text: "BEFORE YOU BUILD" },
        { type: "title", reading_order: 1, text: "/shaping" },
      ],
    },
    semantics: {
      scene: "workflow diagram",
      entities: [{ name: "shaping", type: "tool" }],
      relations: [{ subject: "shaping", predicate: "part of", object: "workflow" }],
    },
    visual: { dominant_colors: ["white", "black"], style: "flat", notes: ["high contrast"] },
    uncertainty: ["cannot read footer watermark"],
  },
  meta: {
    generatedAt: "2026-08-01T12:00:00.000Z",
    model: "gemini-3.6-flash",
    durationSeconds: 6.4,
    usage: { promptTokenCount: 1234 },
    attempts: [{ provider: "gemini-api", ok: true, durationSeconds: 6.4 }],
    warnings: [],
  },
});

test("parseModlensOutput: accepts valid v2 output", () => {
  const parsed = parseModlensOutput(VALID_OUTPUT);
  assert.ok(parsed);
  assert.equal(parsed.provider, "gemini-api");
  assert.equal(parsed.result.summary, "A workflow diagram with four nodes connected by labeled arrows.");
  assert.equal(parsed.result.ocr?.full_text, "/shaping\nBEFORE YOU BUILD\nship less, learn more");
  assert.equal(parsed.meta?.model, "gemini-3.6-flash");
});

test("parseModlensOutput: rejects non-JSON, empty, and non-object payloads", () => {
  assert.equal(parseModlensOutput(""), undefined);
  assert.equal(parseModlensOutput("not json at all"), undefined);
  assert.equal(parseModlensOutput("42"), undefined);
  assert.equal(parseModlensOutput("null"), undefined);
});

test("parseModlensOutput: rejects payloads without a result object", () => {
  assert.equal(parseModlensOutput(JSON.stringify({ error: "boom" })), undefined);
  assert.equal(parseModlensOutput(JSON.stringify({ result: "string-not-object" })), undefined);
});

test("parseModlensOutput: tolerates schema drift — mistyped fields are dropped", () => {
  const parsed = parseModlensOutput(
    JSON.stringify({
      provider: "gemini-api",
      result: {
        summary: "ok",
        ocr: { full_text: 123, lines: [{ text: "keep me" }, { noText: true }, "not-a-record"] },
        layout: { regions: [{ type: "title", text: "kept" }, null] },
        semantics: { entities: [{ name: "e1" }, { type: "nameless" }] },
        uncertainty: ["fine", 42, null],
        brandNewField: { unknown: true },
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.result.summary, "ok");
  // full_text mistyped → dropped; valid lines kept, invalid entries skipped.
  assert.equal(parsed.result.ocr?.full_text, undefined);
  assert.deepEqual(parsed.result.ocr?.lines, [{ text: "keep me" }]);
  assert.equal(parsed.result.layout?.regions?.length, 1);
  // Entity without a name is skipped.
  assert.deepEqual(parsed.result.semantics?.entities, [{ name: "e1" }]);
  assert.deepEqual(parsed.result.uncertainty, ["fine"]);
});

test("formatEvidenceBlock: carries sentinel tags, trust note, and all sections", () => {
  const parsed = parseModlensOutput(VALID_OUTPUT);
  assert.ok(parsed);
  const block = formatEvidenceBlock(
    parsed.result,
    { index: 1, image: "a1b2c3.png", engine: "gemini-api/gemini-3.6-flash" },
    { maxChars: 16000 },
  );

  assert.ok(block.startsWith(EVIDENCE_OPEN_TAG));
  assert.ok(block.endsWith(EVIDENCE_CLOSE_TAG));
  assert.match(block, /index="1"/);
  assert.match(block, /image="a1b2c3\.png"/);
  assert.match(block, /engine="gemini-api\/gemini-3\.6-flash"/);
  assert.match(block, /untrusted quoted content/);
  assert.match(block, /\[summary\] A workflow diagram/);
  assert.match(block, /\[scene\] workflow diagram/);
  assert.match(block, /\[ocr\]/);
  assert.match(block, /\[layout\]/);
  assert.match(block, /\[entities\] shaping \(tool\)/);
  assert.match(block, /\[relations\] shaping → part of → workflow/);
  assert.match(block, /\[visual\] colors: white, black/);
  assert.match(block, /\[uncertainty\]\n- cannot read footer watermark/);
});

test("formatEvidenceBlock: layout regions sorted by reading_order", () => {
  const parsed = parseModlensOutput(VALID_OUTPUT);
  assert.ok(parsed);
  const block = formatEvidenceBlock(parsed.result, { index: 1, image: "x.png" }, { maxChars: 16000 });
  const layout = block.slice(block.indexOf("[layout]"), block.indexOf("[entities]"));
  const firstIdx = layout.indexOf("1.");
  const shapingIdx = layout.indexOf("/shaping");
  const beforeIdx = layout.indexOf("BEFORE YOU BUILD");
  assert.ok(firstIdx >= 0 && shapingIdx > firstIdx);
  // reading_order 1 (/shaping) must precede reading_order 2 (BEFORE YOU BUILD).
  assert.ok(shapingIdx < beforeIdx);
});

test("formatEvidenceBlock: enforces the character budget with a truncation marker", () => {
  const parsed = parseModlensOutput(VALID_OUTPUT);
  assert.ok(parsed);
  // 600 chars is below header + trust note + all sections, so truncation MUST
  // kick in and the block must stay within budget.
  const budget = 600;
  const block = formatEvidenceBlock(parsed.result, { index: 1, image: "x.png" }, { maxChars: budget });

  assert.ok(block.length <= budget, `block length ${block.length} exceeds budget ${budget}`);
  assert.ok(block.includes("[evidence truncated to fit the character budget]"));
  assert.ok(block.endsWith(EVIDENCE_CLOSE_TAG));
  // High-priority sections survive truncation.
  assert.match(block, /\[summary\]/);
});

test("formatEvidenceBlock: budget never breaks the envelope (tiny budgets still well-formed)", () => {
  const parsed = parseModlensOutput(VALID_OUTPUT);
  assert.ok(parsed);
  for (const budget of [10, 100, 300]) {
    const block = formatEvidenceBlock(parsed.result, { index: 2, image: "x.png" }, { maxChars: budget });
    assert.ok(block.startsWith(EVIDENCE_OPEN_TAG));
    assert.ok(block.endsWith(EVIDENCE_CLOSE_TAG));
    assert.ok(block.includes("untrusted quoted content"));
  }
});

test("formatEvidenceBlock: falls back to ocr.lines when full_text is absent", () => {
  const block = formatEvidenceBlock(
    {
      ocr: { lines: [{ text: "line one" }, { text: "line two" }, {}] },
    },
    { index: 1, image: "x.png" },
    { maxChars: 16000 },
  );
  assert.match(block, /\[ocr\]\nline one\nline two/);
});

test("formatEvidenceBlock: empty result yields header + trust note + close tag only", () => {
  const block = formatEvidenceBlock({}, { index: 1, image: "x.png" }, { maxChars: 16000 });
  assert.ok(block.includes(EVIDENCE_OPEN_TAG));
  assert.ok(block.includes("untrusted quoted content"));
  assert.ok(!block.includes("[summary]"));
  assert.ok(!block.includes("truncated"));
});

test("extractFailureReason: prefers the last failing attempt error", () => {
  const stdout = JSON.stringify({
    result: { summary: "unused" },
    meta: {
      attempts: [
        { provider: "gemini-api", ok: false, error: "quota exceeded" },
        { provider: "antigravity-cli", ok: false, error: "CLI not signed in" },
      ],
    },
  });
  assert.equal(extractFailureReason(stdout, "", 1), "CLI not signed in");
});

test("extractFailureReason: falls back to stderr, then stdout, then exit code", () => {
  assert.equal(extractFailureReason("", "line one\nline two", 1), "line one");
  assert.equal(extractFailureReason("raw stdout text", "", 1), "raw stdout text");
  assert.match(extractFailureReason("", "", 127), /exited with code 127/);
});

test("extractFailureReason: caps long reasons at 200 chars", () => {
  const long = "x".repeat(500);
  const reason = extractFailureReason("", long, 1);
  assert.ok(reason.length <= 200);
  assert.ok(reason.endsWith("…"));
});
