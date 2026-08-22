/**
 * Metric computation. Pure functions over decisions and outcomes, no I/O and no brain
 * awareness — the same code must score a two-line baseline and a fine-tuned adapter, or
 * the comparison between them means nothing.
 *
 * Accuracy alone is deliberately not trusted here. FLAT is the correct answer 46% of the
 * time on this data, so a brain can score 46% by refusing to think, and a brain can score
 * 26% while emitting real opinions. Balanced accuracy, MCC and the McNemar p separate
 * those cases; accuracy is kept because it is the number the on-chain record stores.
 */
import type { Decision, Outcome, Side } from './project.js';
import type {
  AccuracyMetrics,
  ActionDistribution,
  ClassScore,
  ConsistencyMetrics,
} from './types.js';
import { SIDES } from './types.js';

function zeroCounts(): Record<Side, number> {
  return { LONG: 0, SHORT: 0, FLAT: 0 };
}

function zeroConfusion(): Record<Side, Record<Side, number>> {
  return { LONG: zeroCounts(), SHORT: zeroCounts(), FLAT: zeroCounts() };
}

export function isSide(value: unknown): value is Side {
  return value === 'LONG' || value === 'SHORT' || value === 'FLAT';
}

/**
 * Why a return is not a `Decision`.
 *
 * The full contract, not just the action. A brain that returns `confidence: 7` is as
 * broken as one that returns `action: "BUY"`, and letting the first through means the
 * confidence field is decorative — at which point nothing downstream can use it.
 *
 * Typed against `unknown` on purpose: the value has crossed a `DecideFn` boundary and
 * there is no reason to believe TypeScript's word for what is on the other side. Every
 * property access below therefore has to survive `null`.
 */
export function malformedReason(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return `decision was ${value === null ? 'null' : typeof value}, not an object`;
  }
  const d = value as Partial<Decision>;
  if (!isSide(d.action)) return `action ${JSON.stringify(d.action)} is not a Side`;
  if (typeof d.confidence !== 'number' || !Number.isFinite(d.confidence)) {
    return `confidence ${JSON.stringify(d.confidence)} is not a finite number`;
  }
  if (d.confidence < 0 || d.confidence > 1) return `confidence ${d.confidence} is outside 0..1`;
  if (typeof d.rationale !== 'string') return 'rationale is not a string';
  if (typeof d.model !== 'string' || d.model.length === 0) return 'model is empty';
  return undefined;
}

/** A malformed return, made safe to score. FLAT so it cannot earn or lose anything. */
export function neutralise(value: unknown, reason: string): Decision {
  const d = (value ?? {}) as Partial<Decision>;
  return {
    action: 'FLAT',
    confidence: 0,
    rationale: `malformed: ${reason}`,
    generation: typeof d.generation === 'number' ? d.generation : -1,
    model: typeof d.model === 'string' && d.model.length > 0 ? d.model : 'malformed',
  };
}

/**
 * A decision the brain returned but could not stand behind.
 *
 * Both shipped brains signal this the same way — a rationale prefixed `unparseable:` —
 * which makes it observable through the `Decision` contract alone. That matters: the
 * harness must never reach into a brain's own counters, or it stops working against
 * arbitrary `DecideFn`s.
 *
 * The prefix alone, without also requiring `confidence === 0`. Both conditions would fail
 * safe in the wrong direction: a brain that reports an unparseable answer with non-zero
 * confidence would slip past the gate, and undercounting parse failures flatters the brain.
 */
export const UNPARSEABLE_PREFIX = 'unparseable:';

export function isParseFailure(decision: Decision): boolean {
  return decision.rationale.startsWith(UNPARSEABLE_PREFIX);
}

export function actionDistribution(actions: readonly Side[]): ActionDistribution {
  const counts = zeroCounts();
  for (const action of actions) counts[action]++;

  const n = actions.length;
  const shares = zeroCounts();
  let entropy = 0;
  for (const side of SIDES) {
    const p = n > 0 ? counts[side] / n : 0;
    shares[side] = p;
    if (p > 0) entropy -= p * Math.log(p);
  }

  return {
    counts,
    shares,
    entropy: entropy / Math.log(SIDES.length),
    minShare: Math.min(...SIDES.map((s) => shares[s])),
    used: SIDES.filter((s) => counts[s] > 0).length,
  };
}

function classScore(confusion: Record<Side, Record<Side, number>>, side: Side): ClassScore {
  const truePositives = confusion[side][side];
  const predicted = SIDES.reduce((sum, truth) => sum + confusion[truth][side], 0);
  const support = SIDES.reduce((sum, said) => sum + confusion[side][said], 0);

  const precision = predicted > 0 ? truePositives / predicted : 0;
  const recall = support > 0 ? truePositives / support : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1, support };
}

/**
 * Multiclass Matthews correlation (Gorodkin's R_K).
 *
 * Chosen over accuracy for the pass gate because it is exactly 0 for any constant
 * predictor. Always-FLAT scores 46% accuracy and MCC 0 — which is the honest reading of a
 * brain that has learned the class prior and nothing else.
 */
export function mcc(confusion: Record<Side, Record<Side, number>>): number {
  let total = 0;
  let correct = 0;
  const trueTotals = zeroCounts();
  const saidTotals = zeroCounts();

  for (const truth of SIDES) {
    for (const said of SIDES) {
      const n = confusion[truth][said];
      total += n;
      trueTotals[truth] += n;
      saidTotals[said] += n;
      if (truth === said) correct += n;
    }
  }
  if (total === 0) return 0;

  let cross = 0;
  let saidSq = 0;
  let trueSq = 0;
  for (const side of SIDES) {
    cross += saidTotals[side] * trueTotals[side];
    saidSq += saidTotals[side] ** 2;
    trueSq += trueTotals[side] ** 2;
  }

  const denominator = Math.sqrt((total ** 2 - saidSq) * (total ** 2 - trueSq));
  // Zero denominator means one side of the comparison never varied; no correlation exists
  // to report, and 0 is the value that says so without pretending to skill.
  return denominator === 0 ? 0 : (correct * total - cross) / denominator;
}

/** Abramowitz & Stegun 7.1.26; |error| < 1.5e-7, far finer than any p-value read off it. */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

/**
 * Two-sided p-value for McNemar's test against always-FLAT.
 *
 * Paired rather than a difference of two independent proportions: the brain and the
 * control answer the *same* bars, so only the bars where they disagree carry information.
 * Continuity-corrected normal approximation, which is adequate at the hundreds-of-bars
 * scale this suite runs at and needs no table lookup.
 *
 * This is the number that stops "+2.17pp, therefore generation 1 improved" from being said
 * out loud on a window where 2.17pp is a coin flip.
 */
export function mcnemarP(brainOnly: number, controlOnly: number): number {
  const discordant = brainOnly + controlOnly;
  if (discordant === 0) return 1;

  const z = (Math.abs(brainOnly - controlOnly) - 1) / Math.sqrt(discordant);
  if (z <= 0) return 1;
  return erfc(z / Math.SQRT2);
}

export function accuracyMetrics(
  actions: readonly Side[],
  outcomes: readonly Outcome[],
): AccuracyMetrics {
  const confusion = zeroConfusion();
  const marketCounts = zeroCounts();
  let correct = 0;
  let flatCorrect = 0;
  let brainOnly = 0;
  let controlOnly = 0;

  for (let i = 0; i < actions.length; i++) {
    const said = actions[i]!;
    const truth = outcomes[i]!.hindsight;
    confusion[truth][said]++;
    marketCounts[truth]++;

    const brainRight = said === truth;
    // Always-FLAT is right exactly when the market's own answer was FLAT. Recomputed from
    // these bars rather than taken from the README: the control is regime-dependent and a
    // remembered number would be a comparison against a different period.
    const controlRight = truth === 'FLAT';
    if (brainRight) correct++;
    if (controlRight) flatCorrect++;
    if (brainRight && !controlRight) brainOnly++;
    if (!brainRight && controlRight) controlOnly++;
  }

  const n = actions.length;
  const perClass = {
    LONG: classScore(confusion, 'LONG'),
    SHORT: classScore(confusion, 'SHORT'),
    FLAT: classScore(confusion, 'FLAT'),
  };

  // Only classes that actually occur can be recalled, so averaging over absent classes
  // would penalise a brain for a quiet market rather than for a bad decision.
  const present = SIDES.filter((s) => perClass[s].support > 0);
  const balancedAccuracy =
    present.length > 0
      ? present.reduce((sum, s) => sum + perClass[s].recall, 0) / present.length
      : 0;

  const accuracy = n > 0 ? correct / n : 0;
  const flatAccuracy = n > 0 ? flatCorrect / n : 0;
  const marketShares = zeroCounts();
  for (const side of SIDES) marketShares[side] = n > 0 ? marketCounts[side] / n : 0;

  return {
    accuracy,
    flatAccuracy,
    edgeOverFlat: accuracy - flatAccuracy,
    balancedAccuracy,
    mcc: mcc(confusion),
    edgePValue: mcnemarP(brainOnly, controlOnly),
    discordant: brainOnly + controlOnly,
    marketShares,
    perClass,
    confusion,
  };
}

/** Collapses a probe's repeated answers into agreement figures. */
export function consistencyMetrics(
  probes: Array<{ at: number; answers: Side[] }>,
  repeats: number,
): ConsistencyMetrics {
  let unanimous = 0;
  let modalSum = 0;
  const flips: Array<{ at: number; answers: Side[] }> = [];

  for (const probe of probes) {
    const counts = zeroCounts();
    for (const answer of probe.answers) counts[answer]++;

    const modal = Math.max(...SIDES.map((s) => counts[s]));
    modalSum += probe.answers.length > 0 ? modal / probe.answers.length : 0;

    if (modal === probe.answers.length && probe.answers.length > 0) unanimous++;
    else flips.push(probe);
  }

  const n = probes.length;
  return {
    probes: n,
    repeats,
    unanimous,
    consistency: n > 0 ? unanimous / n : 1,
    modalAgreement: n > 0 ? modalSum / n : 1,
    // Capped: a fully non-deterministic brain would otherwise dump every probe into the
    // report and bury the numbers that matter.
    flips: flips.slice(0, 10),
  };
}
