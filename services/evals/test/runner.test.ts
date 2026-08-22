/**
 * Runner behaviour: what counts as a bad brain, what counts as a dead service, what the
 * suite refuses to certify, and what has to stay identical between two runs.
 *
 * The outage/quality split is the one worth being pedantic about. If a timed-out adapter
 * server can produce a FAIL verdict, then every red run has to be investigated by hand
 * before it means anything, and the suite stops being something anyone runs on a schedule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Decision, MarketSnapshot, Side } from '../src/project.js';
import {
  DEFAULT_BACKTEST,
  WARMUP,
  buildSnapshot,
  renderSnapshot,
  scoreDecision,
} from '../src/project.js';
import { InsufficientDecisionsError, ServiceUnavailableError, runEval } from '../src/run.js';
import type { RunOptions } from '../src/run.js';
import { DEFAULT_THRESHOLDS } from '../src/thresholds.js';
import type { EvalReport, Holdout } from '../src/types.js';
import { makeCandles, makeHoldout } from './fixtures.js';

const HORIZON = DEFAULT_BACKTEST.horizon;

/** Sized past `minPoweredDecisions`, so a clean run reaches PASS rather than INCONCLUSIVE. */
const candles = makeCandles(700);
const scoreable = Array.from(
  { length: candles.length - HORIZON - WARMUP },
  (_, k) => WARMUP + k,
);
const holdout: Holdout = makeHoldout(candles, scoreable);

const cfg = { ...DEFAULT_BACKTEST, stride: 1 };

function decision(action: Side, overrides: Partial<Decision> = {}): Decision {
  return {
    action,
    confidence: 1,
    rationale: action,
    generation: -1,
    model: 'stub',
    ...overrides,
  };
}

function options(decide: RunOptions['decide'], overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    brain: 'stub',
    decide,
    holdout,
    cfg,
    thresholds: DEFAULT_THRESHOLDS,
    thresholdsSource: 'test',
    thresholdsRelaxed: false,
    seed: 99,
    probes: 8,
    repeats: 2,
    runConsistency: true,
    faultLimit: 3,
    ...overrides,
  };
}

function checkOf(report: EvalReport, id: string) {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `no check "${id}"`);
  return found;
}

/**
 * Builds a brain whose answer is a fixed function of the bar and its hindsight label.
 *
 * Precomputed and resolved by close time rather than by a call counter, so re-presenting a
 * bar gives the same answer: a brain that drifts would fail the consistency check and every
 * test below would then be asserting two things at once.
 */
function fromTruth(pick: (truth: Side, index: number) => Side): RunOptions['decide'] {
  const answer = new Map<number, Side>();
  for (let i = 0; i < candles.length - HORIZON; i++) {
    answer.set(candles[i]!.closeTime, pick(scoreDecision(candles, i, 'FLAT', cfg).hindsight, i));
  }
  const times = [...answer.keys()];
  return async (s: MarketSnapshot) => {
    // Resolved by the bar's own close, so the consistency probe's nudge still lands.
    const key = times.reduce((best, k) => (k <= s.at && k > best ? k : best), -1);
    return decision(answer.get(key) ?? 'FLAT');
  };
}

/** Answers the hindsight label — the positive control, inlined so tests do not need brains.ts. */
function truthful(): RunOptions['decide'] {
  return fromTruth((truth) => truth);
}

const OPPOSITE: Record<Side, Side> = { LONG: 'SHORT', SHORT: 'LONG', FLAT: 'FLAT' };

describe('verdict', () => {
  it('passes a brain that is right every time on a powered window', async () => {
    const report = await runEval(options(truthful()));
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.accuracy.accuracy, 1);
    assert.ok(report.window.powered);
    assert.ok(report.checks.every((c) => c.passed));
  });

  it('fails coverage for a brain that only ever emits one action', async () => {
    const report = await runEval(options(async () => decision('FLAT')));
    assert.equal(report.verdict, 'FAIL');
    assert.equal(checkOf(report, 'coverage').passed, false);
    assert.equal(checkOf(report, 'coverage').severity, 'fail');
  });

  it('reports edge against always-FLAT measured on this window, not a constant', async () => {
    const report = await runEval(options(async () => decision('FLAT')));
    assert.equal(report.accuracy.edgeOverFlat, 0);
    assert.equal(report.accuracy.accuracy, report.accuracy.flatAccuracy);
  });
});

/**
 * The power floor.
 *
 * A window whose own sampling noise is wider than the effect being claimed cannot certify
 * anything, and the suite says so in its own verdict rather than printing PASS under a
 * README that calls the same number an artifact. Note the asymmetry: a small window may
 * still FAIL, because "this was not demonstrated" is safe at any sample size.
 */
describe('underpowered windows', () => {
  const small = { maxDecisions: DEFAULT_THRESHOLDS.minPoweredDecisions - 1 };

  it('refuses to certify a perfect brain when the window is too small', async () => {
    const report = await runEval(options(truthful(), small));
    assert.equal(report.verdict, 'INCONCLUSIVE');
    assert.equal(report.window.powered, false);
    assert.ok(report.checks.every((c) => c.severity !== 'fail' || c.passed));
  });

  it('still fails a brain that lost an action outright', async () => {
    const report = await runEval(options(async () => decision('FLAT'), small));
    assert.equal(report.verdict, 'FAIL');
    assert.equal(checkOf(report, 'coverage').severity, 'fail');
  });

  /**
   * The false negative this exists to remove. A skilled brain that takes a SHORT three times
   * in 499 bars is under the 2% bar by two decisions, and on a window this size that is
   * sampling, not a lost action. It reports; it does not decide.
   */
  it('demotes a thin-share coverage miss to a warning', async () => {
    const report = await runEval(
      options(
        fromTruth((truth, i) => (truth === 'SHORT' && i % 60 !== 0 ? 'FLAT' : truth)),
        small,
      ),
    );
    const coverage = checkOf(report, 'coverage');
    assert.equal(report.actions.used, 3);
    assert.ok(report.accuracy.marketShares.SHORT > DEFAULT_THRESHOLDS.minActionShare);
    assert.equal(coverage.passed, false);
    assert.equal(coverage.severity, 'warn');
    assert.match(coverage.demotedBecause ?? '', /underpowered/);
    assert.equal(report.verdict, 'INCONCLUSIVE');
  });

  it('still fails a brain that is reliably wrong, however small the window', async () => {
    // Real skill, pointed backwards: it pays a round trip on every bar to be wrong.
    const report = await runEval(options(fromTruth((truth) => OPPOSITE[truth]), small));
    assert.equal(report.verdict, 'FAIL');
    assert.equal(checkOf(report, 'economics').passed, false);
  });
});

/**
 * The economic gate.
 *
 * Accuracy and money come apart on this data. A brain can clear the accuracy bar while
 * paying `costPerTrade` on every non-FLAT bar and still end the window deep in the red,
 * and certifying that as improvement is the exact mistake this suite exists to prevent.
 */
describe('economics', () => {
  it('fails a brain that buys its accuracy with money it does not have', async () => {
    // Perfect on the quiet bars, a coin flip on the directional ones. The FLAT calls are
    // free and lift the hit rate 39 points clear of always-FLAT; the directional calls
    // cancel out and leave `costPerTrade` behind on every one of them.
    const report = await runEval(
      options(fromTruth((truth, i) => (truth === 'FLAT' ? 'FLAT' : i % 2 === 0 ? truth : OPPOSITE[truth]))),
    );
    assert.ok(report.accuracy.edgeOverFlat > 0, 'the brain should clear the accuracy bar');
    assert.ok(report.economics.meanReturn < 0, 'and still lose money');
    assert.equal(checkOf(report, 'edge').passed, true);
    assert.equal(checkOf(report, 'skill').passed, true, 'and clear the MCC bar too');
    assert.equal(checkOf(report, 'economics').passed, false);
    assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(
      report.checks.filter((c) => !c.passed && c.severity === 'fail').map((c) => c.id),
      ['economics'],
      'economics is the only gate that sees this',
    );
  });
});

describe('service faults versus bad answers', () => {
  it('calls a brain that throws immediately an outage, not a failure', async () => {
    await assert.rejects(
      runEval(
        options(async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:8177');
        }),
      ),
      ServiceUnavailableError,
    );
  });

  it('tolerates isolated throws and records them without a verdict of its own', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => {
        // Every hundredth call fails, never twice running, so the run should survive and
        // stay under the fault gate.
        if (++calls % 100 === 0) throw new Error('transient 503');
        return decision(calls % 3 === 0 ? 'FLAT' : calls % 2 === 0 ? 'LONG' : 'SHORT');
      }),
    );
    assert.ok(report.integrity.faults > 0);
    assert.equal(report.integrity.firstFault, 'transient 503');
    assert.equal(checkOf(report, 'faults').passed, true);
  });

  /**
   * A verdict computed on a subsample biased by dropped calls is not a verdict. Dropped
   * calls are not a neutral sample — they cluster on the hard prompts and the rate-limited
   * stretches — so past the gate the numbers are withdrawn rather than reported.
   */
  it('fails a brain that drops calls faster than the gate allows', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => {
        if (++calls % 4 === 0) throw new Error('transient 503');
        return decision(calls % 3 === 0 ? 'FLAT' : calls % 2 === 0 ? 'LONG' : 'SHORT');
      }),
    );
    assert.ok(report.integrity.faultRate > DEFAULT_THRESHOLDS.maxFaultRate);
    assert.equal(checkOf(report, 'faults').passed, false);
    assert.equal(checkOf(report, 'faults').severity, 'fail');
    assert.equal(report.verdict, 'FAIL');
  });

  it('counts every attempt, so the fault rate has an honest denominator', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => {
        if (++calls % 100 === 0) throw new Error('transient 503');
        return decision('LONG');
      }),
    );
    assert.equal(report.integrity.attempts, report.integrity.decisions + report.integrity.faults);
  });

  it('gives up once the throws become consecutive', async () => {
    let calls = 0;
    await assert.rejects(
      runEval(
        options(async () => {
          if (++calls > 20) throw new Error('adapter died');
          return decision('LONG');
        }),
      ),
      ServiceUnavailableError,
    );
  });

  it('refuses to render a verdict on too few decisions', async () => {
    await assert.rejects(
      runEval(options(async () => decision('LONG'), { maxDecisions: 10 })),
      InsufficientDecisionsError,
    );
  });

  /**
   * The reachability probe is the run's own first bar, not an extra call before it. Paying
   * for a decision that is then thrown away puts the spend estimate permanently off by one.
   */
  it('spends exactly one call per decision, with no warm-up probe', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => {
        calls++;
        return decision('LONG');
      }, { runConsistency: false, maxDecisions: 600 }),
    );
    assert.equal(calls, 600);
    assert.equal(report.integrity.decisions, 600);
  });
});

/**
 * A bug in a `DecideFn` is a result, not an operator error.
 *
 * Every one of these used to be an uncaught `TypeError` reported as bad usage — a brain
 * bug wearing a "you typed the command wrong" label, which is the single most misleading
 * thing an eval suite can print.
 */
describe('the Decision contract', () => {
  const badReturns: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'LONG'],
    ['an action outside Side', { action: 'BUY', confidence: 1, rationale: 'x', generation: 0, model: 'm' }],
    ['a confidence of 7', { action: 'LONG', confidence: 7, rationale: 'x', generation: 0, model: 'm' }],
    ['a non-string rationale', { action: 'LONG', confidence: 1, rationale: 42, generation: 0, model: 'm' }],
    ['an empty model', { action: 'LONG', confidence: 1, rationale: 'x', generation: 0, model: '' }],
  ];

  for (const [label, value] of badReturns) {
    it(`neutralises ${label} to FLAT and counts it, without throwing`, async () => {
      const report = await runEval(options(async () => value as Decision));

      assert.equal(report.integrity.malformed, report.integrity.decisions);
      assert.equal(report.integrity.malformedRate, 1);
      assert.equal(report.actions.counts.FLAT, report.integrity.decisions);
      assert.ok(report.integrity.firstMalformed);
      assert.equal(checkOf(report, 'contract').passed, false);
      assert.equal(report.verdict, 'FAIL');
    });
  }

  it('survives a brain that is malformed only occasionally', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => (++calls % 50 === 0 ? (null as unknown as Decision) : decision('LONG'))),
    );
    assert.ok(report.integrity.malformed > 0);
    assert.ok(report.integrity.malformed < report.integrity.decisions);
    assert.equal(checkOf(report, 'contract').passed, false);
  });
});

describe('integrity accounting', () => {
  it('counts an unparseable answer without letting it inflate accuracy', async () => {
    const report = await runEval(
      options(async () =>
        decision('FLAT', { confidence: 0, rationale: 'unparseable: LONG or SHORT' }),
      ),
    );
    assert.equal(report.integrity.parseFailures, report.integrity.decisions);
    assert.equal(report.integrity.parseFailureRate, 1);
    assert.equal(checkOf(report, 'parse').passed, false);
  });
});

describe('significance', () => {
  it('is reported as advisory, never as a gate', async () => {
    const report = await runEval(options(truthful()));
    const significance = checkOf(report, 'significance');
    assert.equal(significance.severity, 'warn');
    assert.ok(significance.passed, 'a perfect brain should clear it comfortably');
  });

  it('cannot separate a constant predictor from the control it is identical to', async () => {
    const report = await runEval(options(async () => decision('FLAT')));
    assert.equal(report.accuracy.discordant, 0);
    assert.equal(report.accuracy.edgePValue, 1);
  });
});

describe('determinism', () => {
  /** Timing and identity fields are deliberately absent from the report for this reason. */
  const strip = (r: EvalReport) => JSON.stringify(r);

  it('produces a byte-identical report for a deterministic brain', async () => {
    const first = await runEval(options(truthful()));
    const second = await runEval(options(truthful()));
    assert.equal(strip(first), strip(second));
  });

  it('probes the same bars for the same seed and different bars for a different one', async () => {
    const a = await runEval(options(truthful(), { seed: 1 }));
    const b = await runEval(options(truthful(), { seed: 1 }));
    const c = await runEval(options(truthful(), { seed: 2 }));

    const ats = (r: EvalReport) => r.consistency?.probes ?? 0;
    assert.equal(ats(a), ats(b));
    assert.ok(ats(c) > 0);
  });
});

describe('consistency probe', () => {
  it('scores a brain that answers from the prompt alone as perfectly consistent', async () => {
    const report = await runEval(options(truthful()));
    assert.equal(report.consistency?.consistency, 1);
  });

  it('catches a brain whose answer drifts between identical prompts', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => decision(['LONG', 'SHORT', 'FLAT'][calls++ % 3] as Side)),
    );
    assert.ok((report.consistency?.consistency ?? 1) < 1);
    assert.ok((report.consistency?.flips.length ?? 0) > 0);
    assert.equal(checkOf(report, 'consistency').passed, false);
  });

  it('does not throw when a probed brain returns something that is not a Decision', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => (++calls % 3 === 0 ? (null as unknown as Decision) : decision('LONG'))),
    );
    assert.ok(report.consistency);
  });

  it('can be switched off entirely', async () => {
    const report = await runEval(options(truthful(), { runConsistency: false }));
    assert.equal(report.consistency, null);
    assert.equal(
      report.checks.some((c) => c.id === 'consistency'),
      false,
    );
  });
});

describe('the probe nudge', () => {
  /**
   * The probe defeats the inference response cache by moving `at`, which only works while
   * `renderSnapshot` ignores `at`. If that ever changes the probe silently starts measuring
   * a different prompt, so it is pinned here rather than left as an assumption.
   *
   * The same fact is the documented constraint on brains: anything deriving a feature from
   * `at` is scored inconsistent, because a +1ms nudge on a `.999` close crosses the bar.
   */
  it('leaves the rendered prompt byte-identical when only `at` moves', () => {
    const snapshot = buildSnapshot(candles, 100, 'BTCUSDT', '1h');
    assert.equal(renderSnapshot({ ...snapshot, at: snapshot.at + 1 }), renderSnapshot(snapshot));
  });
});

describe('sampling', () => {
  it('spreads a capped run across the whole window instead of taking a prefix', async () => {
    const report = await runEval(options(truthful(), { maxDecisions: 520 }));
    const full = await runEval(options(truthful()));

    assert.equal(report.integrity.decisions, 520);
    assert.equal(report.window.from, full.window.from);
    assert.equal(report.window.to, full.window.to);
  });
});
