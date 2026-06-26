/**
 * Pure parser for MCP tool responses from the Z.AI Web Search / Web Reader
 * servers.
 *
 * VS Code wraps every tool result in a `LanguageModelToolResult` whose
 * `content` array can be one of several shapes depending on the underlying
 * server. The Z.AI MCP servers are documented to return text in the
 * `content[].text` field, but the exact JSON shape of that text varies.
 *
 * This module is **free of any `vscode` import** so it can be unit-tested
 * under plain Node. Callers convert the `LanguageModelToolResult.content`
 * array to plain strings and pass them in.
 */

/** A single search result after parsing. */
export interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/** A single read result after parsing. */
export interface ParsedReadResult {
  url: string;
  title?: string;
  content: string;
}

/**
 * Walk through any JSON object and try to extract an array of search-result
 * candidates. We try several known field names (in order of likelihood) and
 * also handle the MCP `content: [{type, text}]` wrapper by recursing into
 * the text payload.
 */
export function extractSearchResults(rawText: string): ParsedSearchResult[] {
  const collected = tryExtractFromAny(rawText);
  return collected
    .map((item) => normaliseSearchItem(item))
    .filter((r): r is ParsedSearchResult => r !== undefined);
}

/** Same idea for web-reader results. */
export function extractReadResult(
  rawText: string,
  fallbackUrl: string,
): ParsedReadResult {
  const collected = tryExtractAnyObject(rawText);
  if (collected) {
    const obj = collected as Record<string, unknown>;
    const readerResult =
      obj.reader_result && typeof obj.reader_result === "object"
        ? (obj.reader_result as Record<string, unknown>)
        : obj;
    const content =
      typeof readerResult.content === "string" ? readerResult.content
      : typeof obj.content === "string" ? obj.content
      : typeof obj.markdown === "string" ? obj.markdown
      : typeof obj.text === "string" ? obj.text
      : "";
    const title =
      typeof readerResult.title === "string" ? readerResult.title
      : typeof obj.title === "string" ? obj.title
      : undefined;
    const url =
      typeof readerResult.url === "string" ? readerResult.url
      : typeof obj.url === "string" ? obj.url
      : fallbackUrl;
    return { url, title, content };
  }
  // Not a JSON object — treat the raw text as the body.
  return { url: fallbackUrl, content: rawText };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Field names we know about, in priority order. */
const SEARCH_RESULT_KEYS = [
  "search_result",
  "results",
  "data",
  "output",
  "items",
  "records",
];

/**
 * Try every reasonable shape and return the list of raw candidate items.
 * Returns `[]` if nothing useful was found.
 */
function tryExtractFromAny(raw: string): unknown[] {
  // Use deep parse so a `text` value of `"[{"title":...}]"` (a string
  // whose contents are JSON) is unwrapped to the actual array.
  const parsed = tryJsonParseDeep(raw);
  if (parsed === undefined) return [];

  // 1. Direct array root.
  if (Array.isArray(parsed)) {
    return [...(parsed as unknown[])];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const root = parsed as Record<string, unknown>;

  // 2. Known array field.
  for (const key of SEARCH_RESULT_KEYS) {
    const v = root[key];
    if (Array.isArray(v)) return [...(v as unknown[])];
  }

  // 3. MCP `content: [{type, text}]` wrapper.
  if (Array.isArray(root.content)) {
    const inner = unwrapMcpContent(root.content as unknown[]);
    for (const text of inner) {
      const nested = tryExtractFromAny(text);
      if (nested.length > 0) return nested;
    }
  }

  // 4. `result` field (some MCP wrappers use this).
  if (root.result && typeof root.result === "object") {
    const fromResult = tryExtractFromAny(JSON.stringify(root.result));
    if (fromResult.length > 0) return fromResult;
  }

  return [];
}

/**
 * Extract a single object from any reasonable response shape. Used by the
 * reader parser. Returns `undefined` if no suitable object was found.
 */
function tryExtractAnyObject(raw: string): unknown {
  const parsed = tryJsonParseDeep(raw);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== "object") return undefined;

  const root = parsed as Record<string, unknown>;

  // MCP `content: [{type, text}]` wrapper.
  if (Array.isArray(root.content)) {
    for (const part of root.content as unknown[]) {
      if (!part || typeof part !== "object") continue;
      const item = part as Record<string, unknown>;
      if (typeof item.text === "string") {
        // Try to parse the text as JSON; if that fails, return as raw string.
        const inner = tryJsonParse(item.text);
        if (inner !== undefined && typeof inner === "object") {
          return inner;
        }
        return { text: item.text };
      }
    }
  }

  // Reader result is sometimes nested under `reader_result`.
  if (root.reader_result && typeof root.reader_result === "object") {
    return root.reader_result;
  }

  return root;
}

/** Unwrap the MCP `content: [{type, text}]` array to a list of text strings. */
function unwrapMcpContent(parts: unknown[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (typeof item.text === "string") out.push(item.text);
  }
  return out;
}

function tryJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * The Z.AI MCP server occasionally returns a `text` field whose VALUE is a
 * stringified JSON array/object. E.g. the raw text reads
 *   `"[{\"title\":\"...\"}]"`
 * (note the surrounding quotes — the whole thing is a string that contains
 * a JSON array). A single `JSON.parse` only peels off the outer string and
 * leaves us with another string. This helper peels off up to 3 layers of
 * stringification so we land on the actual array/object.
 */
function tryJsonParseDeep(s: string): unknown {
  let current: unknown = s;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== "string") return current;
    const next = tryJsonParse(current);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/** Normalise an unknown item to a {@link ParsedSearchResult} or `undefined`. */
function normaliseSearchItem(item: unknown): ParsedSearchResult | undefined {
  if (!item || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;

  // Recurse one level if the item itself wraps an MCP content array.
  if (Array.isArray(obj.content)) {
    const unwrapped = unwrapMcpContent(obj.content as unknown[]);
    for (const text of unwrapped) {
      const inner = tryExtractFromAny(text);
      for (const candidate of inner) {
        const result = normaliseSearchItem(candidate);
        if (result) return result;
      }
    }
  }

  const title = typeof obj.title === "string" ? obj.title : undefined;
  const url =
    typeof obj.link === "string" ? obj.link
    : typeof obj.url === "string" ? obj.url
    : undefined;
  const snippet =
    typeof obj.content === "string" ? obj.content
    : typeof obj.snippet === "string" ? obj.snippet
    : typeof obj.summary === "string" ? obj.summary
    : "";
  if (!title || !url) return undefined;
  const source =
    typeof obj.media === "string" ? obj.media
    : typeof obj.source === "string" ? obj.source
    : undefined;
  return { title, url, snippet, source };
}
