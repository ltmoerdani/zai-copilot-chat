/**
 * Pure helpers for detecting Z.AI MCP rate-limit errors and sleeping
 * for exponential-backoff retries.
 *
 * Free of `vscode` imports so it can be unit-tested under plain Node.
 */

/** Thrown when the Z.AI MCP server returns a rate-limit response. */
export class RateLimitError extends Error {
  constructor(message: string, public readonly payload: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Detect a Z.AI MCP rate-limit error in a text payload. The server returns
 * a string like:
 *   `MCP error -429: {"error":{"code":"1302","message":"Rate limit reached for requests"}}`
 *
 * Skips giant bodies to keep the call O(1) on the success path.
 */
export function isRateLimitError(text: unknown): boolean {
  if (typeof text !== "string") return false;
  if (text.length === 0 || text.length > 4_000) return false;
  return /MCP error -429/i.test(text) || /Rate limit/i.test(text);
}

/** Sleep helper for retry backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
