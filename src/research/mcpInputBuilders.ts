/**
 * Pure builders for the `input` payload sent to the Z.AI MCP tools.
 *
 * The Z.AI MCP server enforces a specific schema:
 *   - Web Search: `{ search_query: string, count?: number }`  — the field
 *     name is `search_query`, NOT `query`. Sending `query` causes
 *     `MCP error -400: search_query cannot be empty`.
 *   - Web Reader: `{ url: string, return_format?: "markdown"|"text" }`
 *     — uses `return_format`, not `format`.
 *
 * Keeping these in a `vscode`-free module lets us unit-test the field
 * names without spinning up the VS Code runtime.
 */

/** Build the `input` payload for the Web Search MCP tool. */
export function buildWebSearchInput(
  query: string,
  count: number,
): Record<string, unknown> {
  return { search_query: query, count };
}

/** Build the `input` payload for the Web Reader MCP tool. */
export function buildWebReadInput(
  url: string,
  format: "markdown" | "text",
): Record<string, unknown> {
  return { url, return_format: format };
}
