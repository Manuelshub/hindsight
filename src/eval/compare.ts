/**
 * Cross-generation evaluation.
 *
 * The distinction that matters: a *sealed* evaluation runs only on bars that closed after
 * the generation's on-chain seal, and is the only kind that may be reported as evidence of
 * improvement. A *replay* evaluation runs on historical data for development speed and must
 * be labelled unsealed everywhere it appears.
 */
import type { GenerationStats } from '../types.js';
import { NotImplementedError } from '../errors.js';

export interface EvaluationResult {
  stats: GenerationStats;
  /** True only if every scored bar closed at or after `sealedAt`. */
  sealed: boolean;
  windowStart: number;
  windowEnd: number;
  parseFailureRate: number;
}

/**
 * Guards invariant I2 client-side, mirroring the contract's `EvaluationPredatesSeal`.
 * Throws rather than returning a flag: a caller that forgets to check a boolean would
 * publish an unsealed number as sealed, which is the one failure mode this project cannot
 * afford.
 */
export function assertSealedWindow(_sealedAt: number, _windowStart: number): void {
  throw new NotImplementedError('assertSealedWindow');
}

/** Basis-point conversions for the on-chain record. */
export function toBps(_fraction: number): number {
  throw new NotImplementedError('toBps');
}

export function formatComparison(_results: EvaluationResult[]): string {
  throw new NotImplementedError('formatComparison');
}
