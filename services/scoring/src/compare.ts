/**
 * Cross-generation evaluation.
 *
 * The distinction that matters: a *sealed* evaluation runs only on bars that closed after
 * the generation's on-chain seal, and is the only kind that may be reported as evidence of
 * improvement. A *replay* evaluation runs on historical data for development speed and must
 * be labelled unsealed everywhere it appears.
 */
import type { GenerationStats } from '../../../schemas/index.js';

export interface EvaluationResult {
  stats: GenerationStats;
  /** True only if every scored bar closed at or after `sealedAt`. */
  sealed: boolean;
  windowStart: number;
  windowEnd: number;
  parseFailureRate: number;
}

export class UnsealedEvaluationError extends Error {
  constructor(sealedAt: number, windowStart: number) {
    super(
      `evaluation window starts ${sealedAt - windowStart}s before the seal ` +
        `(sealedAt=${sealedAt}, windowStart=${windowStart}) — this data was visible at ` +
        `training time and cannot be reported as out-of-sample`,
    );
    this.name = 'UnsealedEvaluationError';
  }
}

/**
 * Guards invariant I2 client-side, mirroring the contract's `EvaluationPredatesSeal`.
 *
 * Throws rather than returning a flag: a caller that forgets to check a boolean would
 * publish an unsealed number as sealed, which is the one failure mode this project cannot
 * afford. The contract would reject it too, but by then the number is already in a README.
 */
export function assertSealedWindow(sealedAt: number, windowStart: number): void {
  if (windowStart < sealedAt) throw new UnsealedEvaluationError(sealedAt, windowStart);
}

/** Fraction to basis points, rounded for on-chain integer storage. */
export function toBps(fraction: number): number {
  return Math.round(fraction * 10_000);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

export function formatComparison(results: EvaluationResult[]): string {
  if (results.length === 0) return 'no results';

  const header =
    '  gen  model                 sealed  decisions  accuracy  cumulative   sharpe  parse-fail';
  const rows = results.map((r) => {
    const s = r.stats;
    return [
      `  ${String(s.generation).padStart(3)}`,
      s.model.slice(0, 20).padEnd(20),
      (r.sealed ? 'YES' : 'no').padStart(6),
      String(s.traces).padStart(10),
      pct(s.accuracy).padStart(9),
      pct(s.cumulativeReturn).padStart(11),
      s.sharpe.toFixed(2).padStart(8),
      pct(r.parseFailureRate).padStart(11),
    ].join(' ');
  });

  const anyUnsealed = results.some((r) => !r.sealed);
  const footer = anyUnsealed
    ? '\n  NOTE: rows marked "no" are replay evaluations on historical data.\n' +
      '  They are for development only and must not be reported as evidence of improvement.'
    : '';

  return [header, ...rows].join('\n') + footer;
}
