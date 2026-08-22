/**
 * The pass bar. Frozen: these numbers were written before any brain was measured against
 * them, and lowering one to make a run go green defeats the point of having them.
 *
 * `--thresholds <file>` exists for experiments. Every run records which set it used and
 * stamps `RELAXED` on the summary line, the failure banner and the exit banner when the
 * set was not the frozen one, so a relaxed run cannot be screenshotted as a passing one.
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
   *
   * Demoted to a warning when the market itself paid out that action less often than this,
   * because then the number is measuring the regime and not the brain.
   */
  minActionShare: 0.02,

  /**
   * Accuracy must at least match always-FLAT on the same window.
   *
   * Doing nothing is the hardest baseline here (46.33% on the training window), and a
   * brain below it has negative information value: you would be better off unplugging it.
   */
  minEdgeOverFlat: 0,

  /**
   * The same bar in money, and not redundant with it.
   *
   * Accuracy and profit come apart on this data: a brain can edge ahead on hit rate while
   * paying `costPerTrade` on every non-FLAT bar and still end the window down 70% —
   * mean-reversion does exactly that. Always-FLAT earns exactly zero, so a brain that
   * cannot clear zero has bought its accuracy with money it did not have.
   */
  minMeanReturn: 0,

  /** Above 2% unreadable answers the accuracy figure is measuring the parser, not the brain. */
  maxParseFailureRate: 0.02,

  /**
   * Zero tolerance. An unparseable answer is a model that fumbled a question; a decision
   * that is not a `Decision` is a broken integration, and averaging one into a hit rate
   * produces a number about nothing.
   */
  maxMalformedRate: 0,

  /**
   * Calls that threw, as a share of calls attempted.
   *
   * A dropped call is not a neutral sample — it is disproportionately the hard ones, the
   * long prompts, the rate-limited stretches. Past 2% the surviving decisions are a biased
   * subsample and every metric downstream inherits the bias, so the verdict is withdrawn
   * rather than computed. Set to match the parse gate: both answer "how much of this run
   * is actually about the brain".
   */
  maxFaultRate: 0.02,

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

  /**
   * McNemar two-sided p against always-FLAT. A warning, never a failure.
   *
   * A brain can be genuinely skilled and still miss this on a short window, so failing on
   * it would punish the fixture rather than the brain. It is here to stop a two-point edge
   * on 140 bars being read as an improvement, which is the exact claim this project's
   * lineage rests on.
   */
  maxEdgePValue: 0.05,

  /** Fewer scored decisions than this and there is nothing to compute at all. */
  minDecisions: 100,

  /**
   * The power floor: below this, a clean run is INCONCLUSIVE and never PASS.
   *
   * Derived, not chosen. McNemar's statistic against always-FLAT is z = e*sqrt(n/d) for an
   * edge `e` over `n` paired bars with a discordant fraction `d`. At alpha 0.05 two-sided
   * and 80% power, z must reach 1.96 + 0.84 = 2.80, so n >= d * (2.80 / e)^2.
   *
   * `e` is 8pp — the 95% sampling half-width the `forward` window already carries at 140
   * bars, and therefore the smallest edge this suite can honestly claim to resolve there.
   * `d` is measured, not guessed: the shipped non-constant brains run 0.18 to 0.65
   * discordant against always-FLAT, median 0.44, which gives n >= 0.44 * (2.80/0.08)^2
   * = 535. 500 is that, rounded to a number a reader can hold.
   *
   * The consequence is deliberate and is the point: `forward` at 140 scoreable bars cannot
   * certify anything, and says so in its own exit code instead of printing PASS under a
   * README that calls the same number an artifact.
   *
   * It is not the ~2,000 bars needed to resolve the 2.17pp gap between generations 0 and
   * 1. No offline window in this repository is that large, and a bar nothing can clear is
   * just a suite nobody runs. `significance` carries that finer question as a warning.
   */
  minPoweredDecisions: 500,
};

export function loadThresholds(path?: string): {
  thresholds: Thresholds;
  source: string;
  relaxed: boolean;
} {
  if (!path) return { thresholds: DEFAULT_THRESHOLDS, source: 'frozen default', relaxed: false };

  const overrides = JSON.parse(readFileSync(path, 'utf8')) as Partial<Thresholds>;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };

  // Compared rather than assumed: a file that happens to restate the frozen values is not
  // a relaxed run, and stamping it RELAXED would teach people to ignore the stamp.
  const relaxed = (Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>).some(
    (key) => thresholds[key] !== DEFAULT_THRESHOLDS[key],
  );
  return { thresholds, source: path, relaxed };
}
