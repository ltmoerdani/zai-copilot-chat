/**
 * Minimal concurrency limiter — drop-in replacement for the npm `p-limit`
 * package (which requires bundling node_modules). This avoids bundler setup
 * entirely while keeping the same API surface.
 *
 * Usage:
 *   const limit = pLimit(3);
 *   await Promise.all(items.map((item) => limit(() => doWork(item))));
 */

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Create a concurrency limiter that allows at most `concurrency` tasks
 * to run simultaneously. Returns a function that wraps async work
 * functions; the returned promise resolves once the work completes
 * and a slot is available.
 */
export function pLimit(concurrency: number): (fn: () => Promise<unknown>) => Promise<unknown> {
  if (
    !(Number.isInteger(concurrency) || concurrency === Infinity) ||
    concurrency < 1
  ) {
    throw new TypeError("Expected `concurrency` to be a number from 1 and up");
  }

  const queue: QueueItem[] = [];
  let activeCount = 0;

  const next = (): void => {
    activeCount--;
    if (queue.length > 0) {
      const item = queue.shift()!;
      run(item.fn, item.resolve, item.reject);
    }
  };

  const run = async (
    fn: () => Promise<unknown>,
    resolve: (value: unknown) => void,
    reject: (reason?: unknown) => void,
  ): Promise<void> => {
    activeCount++;
    try {
      resolve(await fn());
    } catch (error) {
      reject(error);
    } finally {
      next();
    }
  };

  const enqueue = (fn: () => Promise<unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      if (activeCount < concurrency) {
        const item = queue.shift()!;
        run(item.fn, item.resolve, item.reject);
      }
    });

  return enqueue;
}
