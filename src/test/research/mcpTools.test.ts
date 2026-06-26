/**
 * Unit tests for the pure MCP tool name resolver.
 *
 * VS Code exposes MCP tools under several naming patterns (bare name,
 * `server.tool`, truncated `mcp_server-truncated_tool_name`, etc.), and
 * Z.AI uses snake_case (`web_search_prime`) while the docs say camelCase
 * (`webSearchPrime`). The resolver must find the tool regardless.
 *
 * These tests exercise the pure helper from `mcpToolNameResolver.ts` (no
 * `vscode` import), so they run under plain Node.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  camelToSnake,
  resolveToolName,
} from "../../research/mcpToolNameResolver.js";

test("resolveToolName: exact match (bare camelCase)", () => {
  const got = resolveToolName("webSearchPrime", [
    { name: "webSearchPrime" },
    { name: "webReader" },
  ]);
  assert.equal(got, "webSearchPrime");
});

test("resolveToolName: exact match (bare snake_case, actual VS Code form)", () => {
  const got = resolveToolName("web_search_prime", [
    { name: "web_search_prime" },
    { name: "webReader" },
  ]);
  assert.equal(got, "web_search_prime");
});

test("resolveToolName: truncated MCP name with snake_case tool", () => {
  // Actual format from VS Code MCP integration (verified Jun 2026).
  const got = resolveToolName("web_search_prime", [
    { name: "mcp_mcp-web-searc_web_search_prime" },
    { name: "mcp_web-reader-se_webReader" },
  ]);
  assert.equal(got, "mcp_mcp-web-searc_web_search_prime");
});

test("resolveToolName: truncated MCP name with camelCase tool", () => {
  const got = resolveToolName("webReader", [
    { name: "mcp_mcp-web-searc_web_search_prime" },
    { name: "mcp_web-reader-se_webReader" },
  ]);
  assert.equal(got, "mcp_web-reader-se_webReader");
});

test("resolveToolName: server.tool dotted notation", () => {
  const got = resolveToolName("webSearchPrime", [
    { name: "zai-web-search-prime.webSearchPrime" },
    { name: "zai-web-reader.webReader" },
  ]);
  assert.equal(got, "zai-web-search-prime.webSearchPrime");
});

test("resolveToolName: server__tool double-underscore notation", () => {
  const got = resolveToolName("web_search_prime", [
    { name: "zai-web-search-prime__web_search_prime" },
    { name: "zai-web-reader__webReader" },
  ]);
  assert.equal(got, "zai-web-search-prime__web_search_prime");
});

test("resolveToolName: substring fallback when no other match", () => {
  const got = resolveToolName("web_search_prime", [
    { name: "my-custom-server-prefixed-name_for_web_search_prime" },
  ]);
  assert.equal(got, "my-custom-server-prefixed-name_for_web_search_prime");
});

test("resolveToolName: returns undefined when no match", () => {
  const got = resolveToolName("web_search_prime", [
    { name: "some_other_tool" },
    { name: "another_tool" },
  ]);
  assert.equal(got, undefined);
});

test("resolveToolName: uses provided cache to avoid re-resolution", () => {
  const cache = new Map<string, string | undefined>();
  cache.set("web_search_prime", "cached_value");
  const got = resolveToolName(
    "web_search_prime",
    [{ name: "should_not_be_used" }],
    cache,
  );
  assert.equal(got, "cached_value");
});

test("camelToSnake: converts correctly", () => {
  assert.equal(camelToSnake("webSearchPrime"), "web_search_prime");
  assert.equal(camelToSnake("webReader"), "web_reader");
  assert.equal(camelToSnake("already_snake"), "already_snake");
  // Two-consecutive-uppercase boundary (e.g. "HTMLElement") is left
  // untouched by the simple regex; this is fine for our use case because
  // Z.AI tool names are simple camelCase.
  assert.equal(camelToSnake("HTMLElement"), "htmlelement");
  assert.equal(camelToSnake("simple"), "simple");
});
