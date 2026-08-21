/**
 * Decision-quality metrics.
 *
 * The gate tests in test/ ask whether the code is correct. These ask whether the brain is
 * worth listening to, which is a different question with a different failure mode: a
 * brain can be perfectly implemented and still emit LONG 93% of the time into a market
 * that rewards FLAT half the time. Every number below exists because some version of that
 * failure was invisible in headline accuracy.
 *
 * Everything here is a pure function of traces. No network, no clock, no randomness
 * beyond the seeded sampler.
 */
import type { Side, Trace } from '../src/types.js';

export const SIDES: readonly Side[] = ['LONG', 'SHORT', 'FLAT'];

export type SideCounts = Record<Side, number>;

export interface ClassMetrics {
  /** how often this action was the right answer */
  support: number;
  /** how often the brain chose it */
  predicted: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ConsistencyMetrics {
  snapshots: number;
  repeats: number;
  /** fraction of probed snapshots where every repeat returned the same action */
  agreementRate: number;
  /** snapshots whose repeats disagreed, with the actions seen */
  disagreements: Array<{ at: number; actions: Side[] }>;
  /**
   * True when the brain is known to answer probes from a cache, which makes the measured
   * agreement a property of the cache rather than of the model.
   */
  cacheSuspected: boolean;
}

export interface EvalMetrics {
  decisions: number;

  accuracy: number;
  /** accuracy of always-FLAT on these exact bars — the control, recomputed, never assumed */
  flatBaselineAccuracy: number;
  accuracyEdge: number;
  /** McNemar two-sided p for the edge; high p means the edge is indistinguishable from noise */
  edgePValue: number;
  /** the best score any single-action policy could have scored here */
  bestConstantAccuracy: number;
  bestConstantAction: Side;

  actionCounts: SideCounts;
  actionShares: SideCounts;
  /** actions used at or above the minimum share; 3 means the brain has a full vocabulary */
  actionsUsed: number;
  unusedActions: Side[];
  maxActionShare: number;
  /** total-variation distance between what the brain played and what the market rewarded */
  distributionDistance: number;

  hindsightCounts: SideCounts;
  perClass: Record<Side, ClassMetrics>;
  /** confusion[chosen][correct] */
  confusion: Record<Side, SideCounts>;

  parseFailureRate: number;
  malformedRate: number;

  meanReturn: number;
  cumulativeReturn: number;

  consistency: ConsistencyMetrics | null;
}

function zeroCounts(): SideCounts {
  return { LONG: 0, SHORT: 0, FLAT: 0 };
}

/**
 * Two-sided p-value for McNemar's test against always-FLAT.
 *
 * Paired rather than a difference of two independent proportions: the brain and the
 * control answer the *same* bars, so only the bars where they disagree carry information.
 * Continuity-corrected normal approximation, which is adequate at the hundreds-of-bars
 * scale this suite runs at and needs no table lookup.
 */
export function mcnemarP(brainOnly: number, controlOnly: number): number {
  const discordant = brainOnly + controlOnly;
  if (discordant === 0) return 1;

  const z = (Math.abs(brainOnly - controlOnly) - 1) / Math.sqrt(discordant);
  if (z <= 0) return 1;
  return erfc(z / Math.SQRT2);
}

/** Abramowitz & Stegun 7.1.26; |error| < 1.5e-7, far finer than any p-value read off it. */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

export function computeMetrics(
  traces: Trace[],
  extras: {
    parseFailures: number;
    malformed: number;
    consistency: ConsistencyMetrics | null;
    minActionShare: number;
  },
): EvalMetrics {
  const n = traces.length;
  const actionCounts = zeroCounts();
  const hindsightCounts = zeroCounts();
  const confusion: Record<Side, SideCounts> = {
    LONG: zeroCounts(),
    SHORT: zeroCounts(),
    FLAT: zeroCounts(),
  };

  let correct = 0;
  let brainOnly = 0;
  let controlOnly = 0;
  let totalReturn = 0;
  let equity = 1;

  for (const t of traces) {
    const chosen = t.decision.action;
    const truth = t.outcome.hindsight;

    actionCounts[chosen]++;
    hindsightCounts[truth]++;
    confusion[chosen][truth]++;

    const brainRight = chosen === truth;
    const controlRight = truth === 'FLAT';
    if (brainRight) correct++;
    if (brainRight && !controlRight) brainOnly++;
    if (!brainRight && controlRight) controlOnly++;

    totalReturn += t.outcome.realizedReturn;
    equity *= Math.exp(t.outcome.realizedReturn);
  }

  const share = (x: number) => (n > 0 ? x / n : 0);
  const actionShares: SideCounts = {
    LONG: share(actionCounts.LONG),
    SHORT: share(actionCounts.SHORT),
    FLAT: share(actionCounts.FLAT),
  };

  const perClass = {} as Record<Side, ClassMetrics>;
  for (const side of SIDES) {
    const hit = confusion[side][side];
    const predicted = actionCounts[side];
    const support = hindsightCounts[side];
    const precision = predicted > 0 ? hit / predicted : 0;
    const recall = support > 0 ? hit / support : 0;
    perClass[side] = {
      support,
      predicted,
      precision,
      recall,
      f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    };
  }

  // Half the L1 distance between the two distributions: 0 means the brain plays each
  // action as often as the market rewards it, 1 means it never plays a rewarded action.
  const distributionDistance =
    SIDES.reduce((acc, s) => acc + Math.abs(actionShares[s] - share(hindsightCounts[s])), 0) / 2;

  let bestConstantAction: Side = 'FLAT';
  for (const side of SIDES) {
    if (hindsightCounts[side] > hindsightCounts[bestConstantAction]) bestConstantAction = side;
  }

  const accuracy = n > 0 ? correct / n : 0;
  const flatBaselineAccuracy = share(hindsightCounts.FLAT);
  const unusedActions = SIDES.filter((s) => actionShares[s] < extras.minActionShare);

  return {
    decisions: n,
    accuracy,
    flatBaselineAccuracy,
    accuracyEdge: accuracy - flatBaselineAccuracy,
    edgePValue: mcnemarP(brainOnly, controlOnly),
    bestConstantAccuracy: share(hindsightCounts[bestConstantAction]),
    bestConstantAction,
    actionCounts,
    actionShares,
    actionsUsed: SIDES.length - unusedActions.length,
    unusedActions,
    maxActionShare: Math.max(...SIDES.map((s) => actionShares[s])),
    distributionDistance,
    hindsightCounts,
    perClass,
    confusion,
    parseFailureRate: n > 0 ? extras.parseFailures / n : 0,
    malformedRate: n > 0 ? extras.malformed / n : 0,
    meanReturn: n > 0 ? totalReturn / n : 0,
    cumulativeReturn: equity - 1,
    consistency: extras.consistency,
  };
}

/**
 * mulberry32. A named, inlined PRNG rather than Math.random so the consistency probe
 * picks the same bars on every machine and every run — the probe is meant to isolate the
 * brain's variance, and a shifting sample would fold the sampler's variance into it.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Seeded sample without replacement, ascending so probing walks the window in order. */
export function sampleIndices(total: number, want: number, seed: number): number[] {
  if (want >= total) return Array.from({ length: total }, (_, i) => i);
  if (want <= 0) return [];

  const pool = Array.from({ length: total }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, want).sort((a, b) => a - b);
}
