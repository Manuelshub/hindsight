/**
 * Behavioural consistency: does the same market produce the same answer twice?
 *
 * This is the metric that decides whether any of the others can be believed. Generation 1
 * beat generation 0 by 2.17 accuracy points. If re-running generation 1 on identical
 * inputs moves it by more than that, the comparison measured sampling noise and the
 * lineage claim collapses.
 *
 * ## The `at` nudge, and the constraint it imposes
 *
 * `renderSnapshot` reads the features and the close, never `at`, while `snapshotHash` —
 * the inference cache key — includes `at`. Shifting `at` by a millisecond therefore hands
 * the brain a byte-identical prompt behind a fresh cache key. Without it the probe would
 * replay `runs/cache` and report a perfect 1.00 for a brain that is in fact wildly
 * unstable: it would be measuring the cache and calling it the model.
 *
 * The cost is a real constraint on what a brain may be. **A brain that derives any feature
 * from `snapshot.at` — hour of day, trading session, day of week — will be scored as
 * behaviourally inconsistent, and the number will be wrong.** `at` is a bar close time
 * ending in `.999`, so a +1ms nudge lands in the next hour and any such feature flips. The
 * suite cannot tell that apart from a model sampling at temperature.
 *
 * If such a brain is ever built, the fix is to bypass the cache instead of the key:
 * `--no-consistency` to skip the probe, or `--no-cache` to run it at full price against a
 * genuinely cold model. Both are honest; silently reporting 40% consistency is not.
 *
 * `RenderDriftError` guards the other half of the trade. The moment `renderSnapshot` starts
 * reading `at`, the prompt stops being identical and the whole probe becomes meaningless —
 * so it throws rather than reporting a number it can no longer stand behind.
 */
import type { BacktestConfig, Candle, DecideFn, Side } from './project.js';
import { buildSnapshot, renderSnapshot } from './project.js';
import type { ConsistencyMetrics } from './types.js';
import { consistencyMetrics, isSide, malformedReason } from './metrics.js';
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
  /** Consecutive throws that end the probe as an outage, matching the main pass. */
  faultLimit: number;
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
  let consecutiveFaults = 0;

  for (const index of chosen) {
    const original = buildSnapshot(
      options.candles,
      index,
      options.cfg.symbol,
      options.cfg.interval,
    );
    const answers: Side[] = [answerAt.get(index)!];

    for (let r = 1; r <= options.repeats; r++) {
      const nudged = { ...original, at: original.at + r };
      if (renderSnapshot(nudged) !== renderSnapshot(original)) throw new RenderDriftError();

      let decision: unknown;
      try {
        decision = await decide(nudged);
        consecutiveFaults = 0;
      } catch (err) {
        // A dropped repeat is one fewer vote, not a disagreement. Scoring it as a flip
        // would report a flaky network as a flaky model, which is the exact confusion the
        // outage/quality split exists to prevent.
        if (++consecutiveFaults >= options.faultLimit) throw err;
        continue;
      }

      // A contract violation is a quality failure the main pass already counts and gates.
      // Treating it as FLAT here keeps the probe about agreement rather than charging the
      // brain twice for the same defect — and, as in the main pass, nothing the brain can
      // return is allowed to throw out of this loop.
      const action =
        malformedReason(decision) === undefined && isSide((decision as { action: unknown }).action)
          ? ((decision as { action: Side }).action)
          : 'FLAT';
      answers.push(action);
    }

    results.push({ at: original.at, answers });
  }

  return consistencyMetrics(results, options.repeats);
}
