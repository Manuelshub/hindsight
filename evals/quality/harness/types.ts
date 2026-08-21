/**
 * Contracts for the decision-quality eval suite.
 *
 * The gate tests in `test/` answer "is the code correct". This suite answers a different
 * question — "is the brain any good" — and the two must not be confused. A brain can be
 * wired up perfectly and still be worthless, which is exactly the state generations 0 and
 * 1 are in: 736 decisions each, zero FLAT, both below the do-nothing baseline.
 */
import type { GenerationStats, Side } from './project.js';

/**
 * Exit codes. The split exists because "the brain is bad" and "the service is down" call
 * for opposite responses — the first is a result worth publishing, the second is an
 * outage worth retrying — and a single non-zero code would make CI treat them alike.
 */
export const EXIT = {
  /** Every gated check met its threshold. */
  pass: 0,
  /** The brain produced decisions and at least one check failed on their quality. */
  qualityFail: 1,
  /** Bad arguments, missing fixture, unknown brain. Nothing was measured. */
  usage: 2,
  /** The brain could not be reached or stopped answering. Nothing was measured. */
  serviceUnavailable: 3,
  /** The held-out window overlaps training data, or is too small to judge on. */
  invalidHoldout: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const SIDES: readonly Side[] = ['LONG', 'SHORT', 'FLAT'];

/** How a window relates to the training data it must not overlap. */
export type WindowRelation = 'after' | 'before';

/**
 * The provenance record for a frozen holdout fixture.
 *
 * `runs/` is gitignored, so the training boundary this fixture was cut against cannot be
 * recomputed on a fresh clone. Recording it here makes the separation claim checkable by
 * anyone holding only the repository, and `build-holdout.ts` re-derives it from the real
 * artefacts whenever they are present.
 */
export interface HoldoutManifest {
  builtAt: string;
  symbol: string;
  interval: string;
  /** Milliseconds per bar for `interval`; used to convert a horizon into wall time. */
  barMs: number;
  training: {
    /** Open time of the earliest candle any training run touched. */
    startAt: number;
    /** Close time of the latest candle any training run touched. */
    endAt: number;
    /** Files the boundary was derived from, so the claim can be audited. */
    sources: string[];
  };
  windows: HoldoutWindowManifest[];
}

export interface HoldoutWindowManifest {
  name: string;
  relation: WindowRelation;
  file: string;
  /** Total candles in the file, including feature-warmup context. */
  candles: number;
  /** Candles eligible to be scored once the boundary and horizon are applied. */
  scoreable: number;
  from: string;
  to: string;
}

/** A loaded window, ready to run against. */
export interface Holdout {
  name: string;
  relation: WindowRelation;
  manifest: HoldoutManifest;
  candles: import('./project.js').Candle[];
  /** Indices into `candles` that may be scored without touching training data. */
  scoreable: number[];
}

export interface ActionDistribution {
  counts: Record<Side, number>;
  shares: Record<Side, number>;
  /** Shannon entropy over the three actions, normalised to 0..1 by log(3). */
  entropy: number;
  /** Share of the least-used action. Zero means an action was never emitted at all. */
  minShare: number;
  /** How many of the three actions appeared at least once. */
  used: number;
}

export interface ClassScore {
  precision: number;
  recall: number;
  f1: number;
  /** How many times this action was the correct answer. */
  support: number;
}

export interface AccuracyMetrics {
  accuracy: number;
  /** Accuracy always-FLAT would have scored on this exact window. */
  flatAccuracy: number;
  /** accuracy - flatAccuracy, in fractions. Negative means worse than doing nothing. */
  edgeOverFlat: number;
  /** Mean per-class recall. Immune to the FLAT-heavy class prior that accuracy rewards. */
  balancedAccuracy: number;
  /** Multiclass Matthews correlation. Exactly 0 for any constant predictor. */
  mcc: number;
  perClass: Record<Side, ClassScore>;
  /** confusion[truth][said] */
  confusion: Record<Side, Record<Side, number>>;
}

export interface IntegrityMetrics {
  decisions: number;
  /** Decisions the brain returned but could not turn into an action. */
  parseFailures: number;
  parseFailureRate: number;
  /** Decisions whose `action` was not one of the three legal sides. */
  invalidActions: number;
  /** Calls that threw. Counted separately because a throw is an outage, not an opinion. */
  faults: number;
  firstFault: string | null;
}

export interface ConsistencyMetrics {
  probes: number;
  repeats: number;
  /** Probes where every repeat agreed with every other and with the original decision. */
  unanimous: number;
  consistency: number;
  /** Mean share of a probe's answers that matched that probe's most common answer. */
  modalAgreement: number;
  /** The disagreements themselves, so a flaky brain can be inspected rather than guessed at. */
  flips: Array<{ at: number; answers: Side[] }>;
}

export interface CheckResult {
  id: string;
  label: string;
  value: number;
  threshold: number;
  comparator: '>=' | '<=';
  passed: boolean;
  /** Why this check exists. Printed on failure so the number is never orphaned. */
  why: string;
}

export interface Thresholds {
  minActionShare: number;
  minEdgeOverFlat: number;
  maxParseFailureRate: number;
  minConsistency: number;
  minMcc: number;
  /** Below this many scored decisions the window cannot support a verdict at all. */
  minDecisions: number;
}

export interface EvalReport {
  brain: string;
  model: string;
  window: {
    name: string;
    relation: WindowRelation;
    symbol: string;
    interval: string;
    from: string;
    to: string;
    trainingStartAt: number;
    trainingEndAt: number;
  };
  seed: number;
  thresholdsSource: string;
  thresholds: Thresholds;
  actions: ActionDistribution;
  accuracy: AccuracyMetrics;
  integrity: IntegrityMetrics;
  /** Null when the probe was disabled with `--no-consistency`. */
  consistency: ConsistencyMetrics | null;
  /** Money terms, reported for context. Never gated: this is not a profitability suite. */
  economics: Pick<
    GenerationStats,
    'meanReturn' | 'cumulativeReturn' | 'sharpe' | 'maxDrawdown'
  >;
  checks: CheckResult[];
  verdict: 'PASS' | 'FAIL';
}
