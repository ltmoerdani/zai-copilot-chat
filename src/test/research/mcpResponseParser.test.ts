/**
 * Unit tests for the MCP response parser.
 *
 * The Z.AI MCP server wraps tool results in the standard MCP envelope:
 *   { content: [{ type: "text", text: "<JSON or stringified JSON>" }] }
 * The inner `text` payload can be the Z.AI REST shape (`search_result: [...]`)
 * or a stringified JSON that needs another parse pass.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  extractReadResult,
  extractSearchResults,
} from "../../research/mcpResponseParser.js";

test("extractSearchResults: bare Z.AI REST shape", () => {
  const raw = JSON.stringify({
    search_result: [
      { title: "A", link: "https://a.example", content: "snippet a" },
      { title: "B", link: "https://b.example", content: "snippet b" },
    ],
  });
  const got = extractSearchResults(raw);
  assert.equal(got.length, 2);
  assert.equal(got[0].title, "A");
  assert.equal(got[0].url, "https://a.example");
  assert.equal(got[1].title, "B");
});

test("extractSearchResults: MCP wrapper with stringified JSON inner text", () => {
  const inner = JSON.stringify({
    search_result: [{ title: "X", link: "https://x", content: "..." }],
  });
  const raw = JSON.stringify({
    content: [{ type: "text", text: inner }],
  });
  const got = extractSearchResults(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "X");
  assert.equal(got[0].url, "https://x");
});

test("extractSearchResults: MCP wrapper with raw text (not JSON)", () => {
  // The MCP server returned a plain-text body, not JSON.
  const raw = JSON.stringify({
    content: [{ type: "text", text: "Just some text, no results here." }],
  });
  const got = extractSearchResults(raw);
  // Plain text is not parseable, so we get nothing.
  assert.equal(got.length, 0);
});

test("extractSearchResults: MCP wrapper with array of text parts", () => {
  const raw = JSON.stringify({
    content: [
      { type: "text", text: "discarded intro text" },
      { type: "text", text: JSON.stringify({
        search_result: [{ title: "Z", link: "https://z.example", content: "ok" }],
      }) },
    ],
  });
  const got = extractSearchResults(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "Z");
});

test("extractSearchResults: alternative field names", () => {
  const variants = [
    { results: [{ title: "R", link: "u" }] },
    { data: [{ title: "D", link: "u" }] },
    { output: [{ title: "O", link: "u" }] },
    { items: [{ title: "I", link: "u" }] },
    { records: [{ title: "Re", link: "u" }] },
  ];
  for (const variant of variants) {
    const got = extractSearchResults(JSON.stringify(variant));
    assert.equal(got.length, 1, `variant: ${Object.keys(variant)[0]}`);
  }
});

test("extractSearchResults: tolerates missing fields (link, media)", () => {
  const raw = JSON.stringify({
    search_result: [
      { title: "no_link", content: "x" },          // skipped (no url)
      { title: "with_link", link: "https://a", content: "y" },  // kept
    ],
  });
  const got = extractSearchResults(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "with_link");
});

test("extractSearchResults: direct array root (no envelope)", () => {
  const raw = JSON.stringify([
    { title: "A", link: "https://a", content: "x" },
    { title: "B", link: "https://b", content: "y" },
  ]);
  const got = extractSearchResults(raw);
  assert.equal(got.length, 2);
});

test("extractSearchResults: non-JSON returns empty", () => {
  const got = extractSearchResults("not json at all");
  assert.equal(got.length, 0);
});

test("extractSearchResults: includes media as source", () => {
  const raw = JSON.stringify({
    search_result: [{ title: "T", link: "u", content: "x", media: "BBC" }],
  });
  const got = extractSearchResults(raw);
  assert.equal(got[0].source, "BBC");
});

test("extractSearchResults: handles double-encoded JSON (text is a stringified array)", () => {
  // The Z.AI MCP server occasionally returns the `text` field as a
  // stringified JSON array — i.e. the value is the string `[{"title":...}]`
  // itself wrapped in another layer of JSON encoding. Reproduces the
  // user-reported "-0 results from MCP wrapper" bug.
  const arrayLiteral = JSON.stringify([
    { title: "Info Lomba", link: "https://example.com", content: "lomba panahan" },
    { title: "World Archery", link: "https://worldarchery.org", content: "registration" },
  ]);
  // Simulate a double-encoded payload: outer JSON wraps the array literal as a string.
  const raw = JSON.stringify(arrayLiteral);
  const got = extractSearchResults(raw);
  assert.equal(got.length, 2);
  assert.equal(got[0].title, "Info Lomba");
  assert.equal(got[1].url, "https://worldarchery.org");
});

test("extractSearchResults: handles triple-encoded JSON (defensive)", () => {
  const arr = [{ title: "A", link: "u", content: "x" }];
  const raw = JSON.stringify(JSON.stringify(JSON.stringify(arr)));
  const got = extractSearchResults(raw);
  assert.equal(got.length, 1);
});

test("extractReadResult: bare reader_result shape", () => {
  const raw = JSON.stringify({
    reader_result: { content: "Hello world", title: "Page T", url: "https://a" },
  });
  const got = extractReadResult(raw, "https://fallback");
  assert.equal(got.content, "Hello world");
  assert.equal(got.title, "Page T");
  assert.equal(got.url, "https://a");
});

test("extractReadResult: MCP wrapper with reader_result", () => {
  const raw = JSON.stringify({
    content: [{
      type: "text",
      text: JSON.stringify({
        reader_result: { content: "From MCP", title: "T", url: "u" },
      }),
    }],
  });
  const got = extractReadResult(raw, "https://fallback");
  assert.equal(got.content, "From MCP");
  assert.equal(got.title, "T");
});

test("extractReadResult: MCP wrapper with plain text body", () => {
  const raw = JSON.stringify({
    content: [{ type: "text", text: "Just a markdown body here." }],
  });
  const got = extractReadResult(raw, "https://fallback");
  assert.equal(got.content, "Just a markdown body here.");
  assert.equal(got.url, "https://fallback");
});

test("extractReadResult: non-JSON returns fallback with raw content", () => {
  const got = extractReadResult("not json", "https://fallback");
  assert.equal(got.content, "not json");
  assert.equal(got.url, "https://fallback");
});
