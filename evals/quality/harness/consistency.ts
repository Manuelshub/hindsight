/**
 * Behavioural consistency: does the same market produce the same answer twice?
 *
 * This is the metric that decides whether any of the others can be believed. Generation 1
 * beat generation 0 by 2.17 accuracy points. If re-running generation 1 on identical
 * inputs moves it by more than that, the comparison measured sampling noise and the
 * lineage claim collapses.
 *
 * The nudge below is the load-bearing trick. `renderSnapshot` reads the features and the
 * close, never `at`, while `snapshotHash` — the inference cache key — includes `at`. So
 * shifting `at` by a millisecond gives the brain a byte-identical prompt behind a fresh
 * cache key. Without it the probe would replay `runs/cache` and report a perfect 1.00 for
 * a brain that is in fact wildly unstable.
 */
import type { BacktestConfig, Candle, DecideFn, Side } from './project.js';
import { buildSnapshot, renderSnapshot } from './project.js';
import type { ConsistencyMetrics } from './types.js';
import { consistencyMetrics, isSide } from './metrics.js';
import { sample } from './rng.js';

export interface ProbeOptions {
  candles: Candle[];
  cfg: BacktestConfig;
  /** Indices already decided in the main pass, in the order they were scored. */
  scored: number[];
  /** The action the main pass got for each entry of `scored`. */
  answers: Side[];
  probes: number;
  repeats: number;
  seed: number;
}

export class RenderDriftError extends Error {
  constructor() {
    super(
      'renderSnapshot output changed when only `at` moved — the consistency probe can no ' +
        'longer guarantee an identical prompt. Fix the probe before trusting its number.',
    );
    this.name = 'RenderDriftError';
  }
}

/**
 * Re-presents a seeded sample of already-decided bars and reports how often the brain
 * agrees with itself.
 *
 * The original answer counts as one of the votes: a brain that answers LONG once and then
 * SHORT three times running is stable-but-wrong on the repeats alone, and that would read
 * as consistency the main pass cannot actually rely on.
 */
export async function probeConsistency(
  decide: DecideFn,
  options: ProbeOptions,
): Promise<ConsistencyMetrics> {
  const chosen = sample(options.scored, options.probes, options.seed).sort((a, b) => a - b);
  const answerAt = new Map<number, Side>();
  for (let k = 0; k < options.scored.length; k++) {
    answerAt.set(options.scored[k]!, options.answers[k]!);
  }

  const results: Array<{ at: number; answers: Side[] }> = [];

  for (const index of chosen) {
    const original = buildSnapshot(options.candles, index, options.cfg.symbol, options.cfg.interval);
    const answers: Side[] = [answerAt.get(index)!];

    for (let r = 1; r <= options.repeats; r++) {
      const nudged = { ...original, at: original.at + r };
      if (renderSnapshot(nudged) !== renderSnapshot(original)) throw new RenderDriftError();

      const decision = await decide(nudged);
      // An illegal action is a quality failure the main pass already counts; treating it
      // as FLAT here keeps the probe about agreement rather than double-charging for it.
      answers.push(isSide(decision.action) ? decision.action : 'FLAT');
    }

    results.push({ at: original.at, answers });
  }

  return consistencyMetrics(results, options.repeats);
}
