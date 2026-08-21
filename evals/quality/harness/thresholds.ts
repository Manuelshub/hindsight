/**
 * The pass bar. Frozen: these numbers were written before any brain was measured against
 * them, and lowering one to make a run go green defeats the point of having them.
 *
 * `--thresholds <file>` exists for experiments, and the report records which set was used
 * so a relaxed run can never be mistaken for a passing one.
 */
import { readFileSync } from 'node:fs';
import type { Thresholds } from './types.js';

export const DEFAULT_THRESHOLDS: Thresholds = {
  /**
   * Every action must appear in at least 2% of decisions.
   *
   * The failure this catches is the one both live generations have: 736 decisions each
   * and not a single FLAT, on a window where FLAT is correct 46% of the time. A brain
   * that has dropped a third of its action space is not choosing — it is stuck.
   */
  minActionShare: 0.02,

  /**
   * Accuracy must at least match always-FLAT on the same window.
   *
   * Doing nothing is the hardest baseline here (46.33%), and a brain below it has
   * negative information value: you would be better off unplugging it.
   */
  minEdgeOverFlat: 0,

  /** Above 2% unreadable answers the accuracy figure is measuring the parser, not the brain. */
  maxParseFailureRate: 0.02,

  /**
   * The same market snapshot must produce the same action at least 95% of the time.
   *
   * Below that, two runs of the same generation differ by more than the gap between
   * generations, and the improvement claim stops being measurable at all.
   */
  minConsistency: 0.95,

  /**
   * Matthews correlation must not be negative.
   *
   * Zero is a constant predictor; below zero is skill pointed backwards. Accuracy cannot
   * see this — always-FLAT scores 46% with an MCC of exactly 0.
   */
  minMcc: 0,

  /** Fewer scored decisions than this and the confidence interval swallows every threshold. */
  minDecisions: 100,
};

export function loadThresholds(path?: string): { thresholds: Thresholds; source: string } {
  if (!path) return { thresholds: DEFAULT_THRESHOLDS, source: 'default' };

  const overrides = JSON.parse(readFileSync(path, 'utf8')) as Partial<Thresholds>;
  return { thresholds: { ...DEFAULT_THRESHOLDS, ...overrides }, source: path };
}
