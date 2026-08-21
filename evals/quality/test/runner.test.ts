/**
 * Runner behaviour: what counts as a bad brain, what counts as a dead service, and what
 * has to stay identical between two runs.
 *
 * The outage/quality split is the one worth being pedantic about. If a timed-out adapter
 * server can produce a FAIL verdict, then every red run has to be investigated by hand
 * before it means anything, and the suite stops being something anyone runs on a schedule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Decision, MarketSnapshot, Side } from '../harness/project.js';
import { WARMUP, buildSnapshot, renderSnapshot, scoreDecision } from '../harness/project.js';
import { DEFAULT_BACKTEST } from '../harness/project.js';
import { InsufficientDecisionsError, ServiceUnavailableError, runEval } from '../harness/run.js';
import type { RunOptions } from '../harness/run.js';
import { DEFAULT_THRESHOLDS } from '../harness/thresholds.js';
import type { EvalReport, Holdout } from '../harness/types.js';
import { makeCandles, makeHoldout } from './fixtures.js';

const HORIZON = DEFAULT_BACKTEST.horizon;
const candles = makeCandles(300);
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
    seed: 99,
    probes: 8,
    repeats: 2,
    runConsistency: true,
    faultLimit: 3,
    ...overrides,
  };
}

/** Answers the hindsight label — the positive control, inlined so tests do not need brains.ts. */
function truthful(): RunOptions['decide'] {
  const answer = new Map<number, Side>();
  for (let i = 0; i < candles.length - HORIZON; i++) {
    answer.set(candles[i]!.closeTime, scoreDecision(candles, i, 'FLAT', cfg).hindsight);
  }
  return async (s: MarketSnapshot) => {
    // Resolved by the bar's own close, so the consistency probe's nudge still lands.
    const key = [...answer.keys()].reduce((best, k) => (k <= s.at && k > best ? k : best), -1);
    return decision(answer.get(key) ?? 'FLAT');
  };
}

describe('verdict', () => {
  it('passes a brain that is right every time', async () => {
    const report = await runEval(options(truthful()));
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.accuracy.accuracy, 1);
    assert.ok(report.checks.every((c) => c.passed));
  });

  it('fails coverage for a brain that only ever emits one action', async () => {
    const report = await runEval(options(async () => decision('FLAT')));
    assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(
      report.checks.filter((c) => !c.passed).map((c) => c.id),
      ['coverage'],
    );
  });

  it('reports edge against always-FLAT measured on this window, not a constant', async () => {
    const report = await runEval(options(async () => decision('FLAT')));
    assert.equal(report.accuracy.edgeOverFlat, 0);
    assert.equal(report.accuracy.accuracy, report.accuracy.flatAccuracy);
  });
});

describe('service faults versus bad answers', () => {
  it('calls a brain that throws immediately an outage, not a failure', async () => {
    await assert.rejects(
      runEval(options(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8177');
      })),
      ServiceUnavailableError,
    );
  });

  it('tolerates isolated throws and records them without a verdict of its own', async () => {
    let calls = 0;
    const report = await runEval(
      options(async () => {
        // Every seventh call fails, never twice running, so the run should survive.
        if (++calls % 7 === 0) throw new Error('transient 503');
        return decision(calls % 2 === 0 ? 'LONG' : 'SHORT');
      }),
    );
    assert.ok(report.integrity.faults > 0);
    assert.equal(report.integrity.firstFault, 'transient 503');
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
    assert.equal(report.checks.find((c) => c.id === 'parse')?.passed, false);
  });

  it('counts an illegal action and scores it as FLAT rather than aborting', async () => {
    const report = await runEval(
      options(async () => decision('BUY' as Side)),
    );
    assert.equal(report.integrity.invalidActions, report.integrity.decisions);
    assert.equal(report.actions.counts.FLAT, report.integrity.decisions);
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
    assert.equal(report.checks.find((c) => c.id === 'consistency')?.passed, false);
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
   */
  it('leaves the rendered prompt byte-identical when only `at` moves', () => {
    const snapshot = buildSnapshot(candles, 100, 'BTCUSDT', '1h');
    assert.equal(renderSnapshot({ ...snapshot, at: snapshot.at + 1 }), renderSnapshot(snapshot));
  });
});

describe('sampling', () => {
  it('spreads a capped run across the whole window instead of taking a prefix', async () => {
    const report = await runEval(options(truthful(), { maxDecisions: 120 }));
    const full = await runEval(options(truthful()));

    assert.equal(report.integrity.decisions, 120);
    assert.equal(report.window.from, full.window.from);
    assert.equal(report.window.to, full.window.to);
  });
});
