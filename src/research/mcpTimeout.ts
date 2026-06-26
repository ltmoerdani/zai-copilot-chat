/**
 * Pure helpers for timeouts on MCP tool calls.
 *
 * `vscode.lm.invokeTool()` does not accept an `AbortSignal`, so we cannot
 * cancel an in-flight call from the client side. The best we can do is
 * race the call against a timeout — the underlying HTTP request will
 * continue in the background but we stop awaiting it.
 *
 * Free of `vscode` imports so it can be unit-tested under plain Node.
 */

/** Thrown when an async operation exceeds its time budget. */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Race a thenable against a timeout. If the timeout wins, the returned
 * promise rejects with a `TimeoutError`. The original thenable is left
 * to resolve/reject in the background (we no longer await it).
 *
 * Accepts `Thenable<T>` (not just `Promise<T>`) so it can wrap
 * `vscode.lm.invokeTool()` which returns a Thenable.
 */
export function withTimeout<T>(
  p: Thenable<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(p);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(p), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
