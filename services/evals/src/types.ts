/**
 * Contracts for the decision-quality eval suite.
 *
 * The gate tests in each service's `test/` answer "is the code correct". This suite
 * answers a different question — "is the brain any good" — and the two must not be
 * confused. A brain can be wired up perfectly and still be worthless, which is exactly the
 * state generations 0 and 1 are in: 736 decisions each, zero FLAT, both below the
 * do-nothing baseline.
 */
import type { GenerationStats, Side } from './project.js';

/**
 * Exit codes. The split exists because "the brain is bad", "the service is down" and "this
 * window cannot answer the question" call for opposite responses — the first is a result
 * worth publishing, the second is an outage worth retrying, the third is a fixture that
 * has to grow — and a single non-zero code would make CI treat them alike.
 */
export const EXIT = {
  /** Every gated check met its threshold on a window large enough to mean it. */
  pass: 0,
  /** The brain produced decisions and at least one gated check failed on their quality. */
  qualityFail: 1,
  /** Bad arguments, missing fixture, unknown brain. Nothing was measured. */
  usage: 2,
  /** The brain could not be reached or stopped answering. Nothing was measured. */
  serviceUnavailable: 3,
  /** The held-out window overlaps training data, or is too small to score at all. */
  invalidHoldout: 4,
  /**
   * Nothing failed, but the window is too small to certify a pass.
   *
   * Distinct from every other code on purpose. Folding it into 0 would print a green tick
   * for a number the suite's own README calls an artifact; folding it into 1 would blame
   * the brain for the fixture's size. Automation reads the exit code and nothing else, so
   * "not yet provable" needs its own.
   */
  inconclusive: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

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
  /**
   * Two-sided McNemar p for `edgeOverFlat` against always-FLAT on the same bars. High p
   * means the edge is indistinguishable from the noise in this window.
   */
  edgePValue: number;
  /** Bars where exactly one of the brain and always-FLAT was right. McNemar's denominator. */
  discordant: number;
  /** What the market itself paid out, so a gate can tell brain scarcity from market scarcity. */
  marketShares: Record<Side, number>;
  perClass: Record<Side, ClassScore>;
  /** confusion[truth][said] */
  confusion: Record<Side, Record<Side, number>>;
}

export interface IntegrityMetrics {
  decisions: number;
  /** Calls attempted, including the ones that threw. The denominator for `faultRate`. */
  attempts: number;
  /** Decisions the brain returned but could not turn into an action. */
  parseFailures: number;
  parseFailureRate: number;
  /**
   * Returns that violated the `Decision` contract outright — null, wrong type, an action
   * that is not a `Side`, a confidence outside 0..1, a non-string rationale, an empty
   * model. Neutralised to FLAT and counted, never thrown.
   */
  malformed: number;
  malformedRate: number;
  firstMalformed: string | null;
  /** Calls that threw. Counted separately because a throw is an outage, not an opinion. */
  faults: number;
  /** faults / attempts. A verdict on a subsample this biased is not a verdict. */
  faultRate: number;
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

/**
 * Whether a check can end a run.
 *
 * `fail` decides the exit code. `warn` is printed and recorded but never does — reserved
 * for checks whose answer depends on how much data the window happens to hold, so that a
 * short fixture cannot manufacture a verdict in either direction.
 */
export type Severity = 'fail' | 'warn';

export interface CheckResult {
  id: string;
  label: string;
  value: number;
  threshold: number;
  comparator: '>=' | '<=';
  passed: boolean;
  severity: Severity;
  /** Set when severity was lowered from `fail`, naming the reason. Printed with the check. */
  demotedBecause?: string;
  /** Why this check exists. Printed on failure so the number is never orphaned. */
  why: string;
}

export interface Thresholds {
  minActionShare: number;
  minEdgeOverFlat: number;
  /** Mean realised return per decision. Always-FLAT earns exactly 0, so 0 is the bar. */
  minMeanReturn: number;
  maxParseFailureRate: number;
  maxMalformedRate: number;
  maxFaultRate: number;
  minConsistency: number;
  minMcc: number;
  /** Above this, a positive edge is not distinguishable from noise. Warning, not a failure. */
  maxEdgePValue: number;
  /** Below this many scored decisions the window cannot support a verdict at all. */
  minDecisions: number;
  /** Below this many, it can support a FAIL but never a PASS. See `thresholds.ts`. */
  minPoweredDecisions: number;
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
    /** False when the window is too small to certify a pass on. */
    powered: boolean;
  };
  seed: number;
  thresholdsSource: string;
  /** True when `--thresholds` moved the bar. Stamped RELAXED everywhere the verdict prints. */
  thresholdsRelaxed: boolean;
  thresholds: Thresholds;
  actions: ActionDistribution;
  accuracy: AccuracyMetrics;
  integrity: IntegrityMetrics;
  /** Null when the probe was disabled with `--no-consistency`. */
  consistency: ConsistencyMetrics | null;
  /** Money terms. `meanReturn` is gated; the rest are reported for context. */
  economics: Pick<
    GenerationStats,
    'meanReturn' | 'cumulativeReturn' | 'sharpe' | 'maxDrawdown'
  >;
  checks: CheckResult[];
  verdict: Verdict;
}
