/**
 * Token / iteration / source budget manager for the orchestrator.
 *
 * Prevents runaway research runs by enforcing three independent caps. The
 * orchestrator must call `exhausted()` before each iteration and `consume*`
 * after each unit of work.
 *
 * Token counts are estimates (≈ chars/4) — accurate enough for budgeting
 * without paying for a real tokenizer on every chunk.
 */

export interface BudgetOptions {
  maxTokens: number;
  maxIterations: number;
  maxSources: number;
}

export interface BudgetSnapshot {
  tokensUsed: number;
  maxTokens: number;
  iterationsUsed: number;
  maxIterations: number;
  sourcesFetched: number;
  maxSources: number;
}

/** Rough chars→tokens estimate used for budget accounting. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK-heavy text is ~1 token/char; latin ~0.25 token/char. Average ~1/3.5.
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu) ?? "").length;
  const latin = text.length - cjk;
  return Math.ceil(cjk + latin / 4);
}

export class BudgetManager {
  private tokensUsed = 0;
  private iterationsUsed = 0;
  private sourcesFetched = 0;

  constructor(private readonly opts: BudgetOptions) {}

  exhausted(): boolean {
    return (
      this.tokensUsed >= this.opts.maxTokens ||
      this.iterationsUsed >= this.opts.maxIterations ||
      this.sourcesFetched >= this.opts.maxSources
    );
  }

  consumeTokens(n: number): void {
    if (n > 0) this.tokensUsed += n;
  }

  consumeIteration(): void {
    this.iterationsUsed++;
  }

  consumeSource(): void {
    this.sourcesFetched++;
  }

  /** True if there is room for at least one more source. */
  canFetchMore(): boolean {
    return (
      this.sourcesFetched < this.opts.maxSources &&
      this.tokensUsed < this.opts.maxTokens
    );
  }

  snapshot(): BudgetSnapshot {
    return {
      tokensUsed: this.tokensUsed,
      maxTokens: this.opts.maxTokens,
      iterationsUsed: this.iterationsUsed,
      maxIterations: this.opts.maxIterations,
      sourcesFetched: this.sourcesFetched,
      maxSources: this.opts.maxSources,
    };
  }
}
