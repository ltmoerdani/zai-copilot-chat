/**
 * Pure resolver for VS Code MCP tool names.
 *
 * VS Code exposes MCP tools under several naming patterns, with mixed case:
 *   - `webSearchPrime`                              (bare camelCase)
 *   - `web_search_prime`                            (bare snake_case)
 *   - `zai-web-search-prime.webSearchPrime`         (server.tool dot)
 *   - `zai-web-search-prime__web_search_prime`      (server__tool dunder)
 *   - `mcp_zai-web-searc_web_search_prime`          (truncated, snake)
 *
 * This file is **free of any `vscode` import** so it can be unit-tested
 * under plain Node. The `McpToolInvoker` calls these helpers and passes
 * the actual list of available tools from `vscode.lm.tools`.
 */

export interface ToolDescriptor {
  readonly name: string;
}

/**
 * Resolve a preferred tool name against a list of available tools.
 * Returns the actual tool name that should be used to call the tool, or
 * `undefined` if no match is found.
 */
export function resolveToolName(
  preferred: string,
  available: readonly ToolDescriptor[],
  nameCache?: Map<string, string | undefined>,
): string | undefined {
  const cache = nameCache ?? new Map<string, string | undefined>();
  const cached = cache.get(preferred);
  if (cached !== undefined) return cached;

  const lowerPreferred = preferred.toLowerCase();
  const snakePreferred = camelToSnake(lowerPreferred);

  // 1. Exact match (preferred as-is)
  const exact = available.find((t) => t.name === preferred);
  if (exact) {
    cache.set(preferred, exact.name);
    return exact.name;
  }

  // 2. Match by last segment of the tool name (handles `server.tool` /
  //    `server__tool` with mixed case).
  const lastSegmentMatch = available.find((t) => {
    const last = t.name.split(/[._]/).pop() ?? "";
    const lastLower = last.toLowerCase();
    return lastLower === lowerPreferred || lastLower === snakePreferred;
  });
  if (lastSegmentMatch) {
    cache.set(preferred, lastSegmentMatch.name);
    return lastSegmentMatch.name;
  }

  // 3. Substring match on the full tool name (case-insensitive).
  const substringMatch = available.find(
    (t) =>
      t.name.toLowerCase().includes(lowerPreferred) ||
      t.name.toLowerCase().includes(snakePreferred),
  );
  if (substringMatch) {
    cache.set(preferred, substringMatch.name);
    return substringMatch.name;
  }

  cache.set(preferred, undefined);
  return undefined;
}

/** Convert camelCase (or PascalCase) to snake_case. */
export function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
