/**
 * Gate tests for the eval suite itself.
 *
 *   pnpm eval:test
 *
 * An eval that silently mis-measures is worse than no eval, because it produces a number
 * people act on. These are deterministic, offline and free, and they run against
 * synthetic brains built to trip each metric on purpose — including the two failure modes
 * the suite exists to tell apart: a brain that is bad, and a brain that never answered.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Candle, Decision, MarketSnapshot, Side } from '../src/types.js';
import { DEFAULT_BACKTEST } from '../src/types.js';
import type { DecideFn } from '../src/sim/backtest.js';
import { WARMUP } from '../src/features/indicators.js';

import { computeMetrics, mcnemarP, mulberry32, sampleIndices } from './metrics.js';
import { DEFAULT_THRESHOLDS, failed, runChecks } from './thresholds.js';
import { DEFAULT_EVAL_OPTIONS, decisionCount, evaluate, type Brain } from './harness.js';
import { assertHeldOut, type Holdout } from './holdout.js';
import {
  BrainContractError,
  EXIT,
  HoldoutIntegrityError,
  ServiceUnavailableError,
  exitCodeFor,
  isTransportError,
} from './exit-codes.js';

const HOUR = 3_600_000;
const START = Date.UTC(2025, 0, 1);

/**
 * A price path with a deterministic shape: a slow drift plus a sine, so the window
 * contains all three hindsight labels without depending on any real market file.
 */
function syntheticCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 0.9 + Math.sin(i / 31) * 0.4;
    const open = price;
    price = Math.max(1, price + drift);
    candles.push({
      openTime: START + i * HOUR,
      open,
      high: Math.max(open, price) + 0.2,
      low: Math.min(open, price) - 0.2,
      close: price,
      volume: 1000 + (i % 17) * 10,
      closeTime: START + (i + 1) * HOUR - 1,
    });
  }
  return candles;
}

function holdoutOf(candles: Candle[]): Holdout {
  return {
    schemaVersion: 1,
    symbol: 'TESTUSDT',
    interval: '1h',
    generatedAt: '2025-01-01T00:00:00.000Z',
    source: 'synthetic',
    excluded: [],
    candles,
  };
}

function brainOf(name: string, decide: DecideFn, overrides: Partial<Brain> = {}): Brain {
  return { name, decide, free: true, cachedResponses: false, ...overrides };
}

function decision(action: Side, extra: Partial<Decision> = {}): Decision {
  return {
    action,
    confidence: 1,
    rationale: `test:${action}`,
    generation: -1,
    model: 'test',
    ...extra,
  };
}

const constant = (action: Side): DecideFn => async () => decision(action);

const options = {
  ...DEFAULT_EVAL_OPTIONS,
  cfg: { ...DEFAULT_BACKTEST, symbol: 'TESTUSDT', interval: '1h', stride: 1 },
  consistencyProbes: 8,
};

const CANDLES = syntheticCandles(400);
const HOLDOUT = holdoutOf(CANDLES);

test('a one-action brain fails action coverage and concentration', async () => {
  const run = await evaluate(brainOf('always-long', constant('LONG')), HOLDOUT, options);

  assert.equal(run.metrics.actionsUsed, 1);
  assert.deepEqual(run.metrics.unusedActions, ['SHORT', 'FLAT']);
  assert.equal(run.metrics.maxActionShare, 1);

  const ids = failed(run.checks).map((c) => c.id);
  assert.ok(ids.includes('action-coverage'));
  assert.ok(ids.includes('action-concentration'));
  assert.equal(run.passed, false);
});

test('the always-flat control scores exactly the flat baseline, so the edge is zero', async () => {
  const run = await evaluate(brainOf('flat', constant('FLAT')), HOLDOUT, options);

  assert.equal(run.metrics.accuracy, run.metrics.flatBaselineAccuracy);
  assert.equal(run.metrics.accuracyEdge, 0);
  assert.equal(run.metrics.edgePValue, 1);
});

test('an oracle brain beats the flat baseline with a significant edge', async () => {
  // Reads the future deliberately: this is the only brain in the repo allowed to, and it
  // exists to prove the metric can detect skill at all.
  const byTime = new Map(CANDLES.map((c, i) => [c.closeTime, i]));
  const oracle: DecideFn = async (s: MarketSnapshot) => {
    const i = byTime.get(s.at)!;
    const fwd = Math.log(CANDLES[i + DEFAULT_BACKTEST.horizon]!.close / CANDLES[i]!.close);
    const action: Side =
      fwd > DEFAULT_BACKTEST.flatThreshold ? 'LONG' : fwd < -DEFAULT_BACKTEST.flatThreshold ? 'SHORT' : 'FLAT';
    return decision(action);
  };

  const run = await evaluate(brainOf('oracle', oracle), HOLDOUT, options);

  assert.equal(run.metrics.accuracy, 1);
  assert.ok(run.metrics.accuracyEdge > 0);
  assert.ok(run.metrics.edgePValue < 0.05);
  assert.equal(run.metrics.actionsUsed, 3);
  assert.equal(run.passed, true);
});

test('unparseable responses are counted, not hidden in the accuracy', async () => {
  let n = 0;
  const flaky: DecideFn = async () =>
    n++ % 4 === 0
      ? decision('FLAT', { confidence: 0, rationale: 'unparseable: it depends on your risk' })
      : decision('LONG');

  const run = await evaluate(brainOf('flaky', flaky), HOLDOUT, options);

  assert.ok(Math.abs(run.metrics.parseFailureRate - 0.25) < 0.02);
  assert.ok(failed(run.checks).some((c) => c.id === 'parse-failures'));
});

test('a decision that violates the contract is neutralised and counted as malformed', async () => {
  const broken: DecideFn = async () =>
    ({ action: 'BUY', confidence: 4, rationale: '', generation: 0, model: 'x' } as unknown as Decision);

  const run = await evaluate(brainOf('broken', broken), HOLDOUT, options);

  assert.equal(run.metrics.malformedRate, 1);
  assert.equal(run.metrics.actionCounts.FLAT, run.metrics.decisions);
  assert.ok(failed(run.checks).some((c) => c.id === 'malformed-decisions'));
});

test('a brain that answers differently on identical input fails self-consistency', async () => {
  const seen = new Map<number, number>();
  const drifting: DecideFn = async (s) => {
    const count = (seen.get(s.at) ?? 0) + 1;
    seen.set(s.at, count);
    // Stable on the first pass, wobbles only when re-asked, which is exactly the failure
    // the probe exists to catch: it is invisible in a single pass over the window.
    return decision(count === 1 ? 'LONG' : count % 2 === 0 ? 'SHORT' : 'FLAT');
  };

  const run = await evaluate(brainOf('drifting', drifting), HOLDOUT, options);

  assert.equal(run.metrics.consistency?.agreementRate, 0);
  assert.equal(run.metrics.consistency?.disagreements.length, options.consistencyProbes);
  assert.ok(failed(run.checks).some((c) => c.id === 'self-consistency'));
});

test('consistency probes are seeded, so two runs probe the same bars', async () => {
  const a = sampleIndices(500, 12, 42);
  const b = sampleIndices(500, 12, 42);
  const c = sampleIndices(500, 12, 43);

  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, 12);
  assert.deepEqual(a, [...a].sort((x, y) => x - y));

  const rand = mulberry32(1);
  assert.equal(mulberry32(1)(), rand());
});

test('a dead service aborts the run instead of scoring it', async () => {
  const dead: DecideFn = async () => {
    throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8177');
  };

  await assert.rejects(
    () => evaluate(brainOf('adapter', dead), HOLDOUT, options),
    (err: unknown) => {
      assert.ok(err instanceof ServiceUnavailableError);
      assert.equal(exitCodeFor(err), EXIT.SERVICE);
      return true;
    },
  );
});

test('a brain that throws for its own reasons is a brain error, not an outage', async () => {
  const buggy: DecideFn = async () => {
    throw new TypeError("cannot read properties of undefined (reading 'rsi14')");
  };

  await assert.rejects(
    () => evaluate(brainOf('buggy', buggy), HOLDOUT, options),
    (err: unknown) => {
      assert.ok(err instanceof BrainContractError);
      assert.equal(exitCodeFor(err), EXIT.BRAIN_ERROR);
      return true;
    },
  );
});

test('one dropped socket is retried; the run finishes and is flagged', async () => {
  let thrown = false;
  const flapping: DecideFn = async () => {
    if (!thrown) {
      thrown = true;
      throw new Error('socket hang up');
    }
    return decision('LONG');
  };

  const run = await evaluate(brainOf('flapping', flapping), HOLDOUT, options);

  assert.equal(run.transportRetries, 1);
  assert.equal(run.metrics.decisions, decisionCount(CANDLES.length, options.cfg));
});

test('transport patterns cover the shapes the three brains actually fail with', () => {
  for (const message of [
    'adapter server unreachable at http://127.0.0.1:8177',
    'inference 429: too many requests',
    'inference 503: upstream unavailable',
    'The operation was aborted due to timeout',
    'getaddrinfo ENOTFOUND rpc.testnet',
    'adapter server at http://127.0.0.1:8177 has no model loaded',
  ]) {
    assert.ok(isTransportError(new Error(message)), message);
  }

  assert.equal(isTransportError(new Error('confidence 4 is outside 0..1')), false);
  assert.equal(isTransportError(new BrainContractError('rate limit')), false);
});

test('the held-out window is rejected when it touches a training window', () => {
  const overlapping = [
    { label: 'runs/gen-1', from: CANDLES[10]!.openTime, to: CANDLES[20]!.closeTime },
  ];
  assert.throws(() => assertHeldOut(HOLDOUT, overlapping), HoldoutIntegrityError);
  assert.equal(exitCodeFor(new HoldoutIntegrityError('x')), EXIT.HOLDOUT);

  // Touching by a single millisecond is still touching.
  const abutting = [
    { label: 'abutting', from: CANDLES.at(-1)!.closeTime, to: CANDLES.at(-1)!.closeTime + HOUR },
  ];
  assert.throws(() => assertHeldOut(HOLDOUT, abutting), HoldoutIntegrityError);

  const clear = [
    { label: 'later', from: CANDLES.at(-1)!.closeTime + 1, to: CANDLES.at(-1)!.closeTime + HOUR },
  ];
  const report = assertHeldOut(HOLDOUT, clear);
  assert.equal(report.bars, CANDLES.length);
  assert.equal(report.checkedAgainst.length, 1);
});

test('mcnemar only counts disagreements, and a tie is never significant', () => {
  assert.equal(mcnemarP(0, 0), 1);
  assert.equal(mcnemarP(50, 50), 1);
  assert.ok(mcnemarP(60, 20) < 0.001);
  assert.equal(mcnemarP(60, 20), mcnemarP(20, 60));
  assert.ok(mcnemarP(12, 8) > 0.05);
});

test('distribution distance is 0 for a brain matching the market and 1 for one avoiding it', () => {
  const trace = (chosen: Side, truth: Side) => ({
    id: `${chosen}-${truth}`,
    snapshot: {} as MarketSnapshot,
    decision: decision(chosen),
    outcome: { forwardReturn: 0, realizedReturn: 0, hindsight: truth, correct: chosen === truth },
  });
  const extras = { parseFailures: 0, malformed: 0, consistency: null, minActionShare: 0.02 };

  const matched = computeMetrics(
    [trace('LONG', 'LONG'), trace('SHORT', 'SHORT'), trace('FLAT', 'FLAT')],
    extras,
  );
  assert.equal(matched.distributionDistance, 0);

  const avoided = computeMetrics([trace('LONG', 'FLAT'), trace('LONG', 'SHORT')], extras);
  assert.equal(avoided.distributionDistance, 1);
});

test('thresholds are frozen at the documented values', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    minActionShare: 0.02,
    minActionsUsed: 3,
    maxActionShare: 0.9,
    minAccuracyEdge: 0,
    maxEdgePValue: 0.05,
    maxParseFailureRate: 0.02,
    maxMalformedRate: 0,
    minSelfAgreement: 0.95,
  });

  // Every check must name the threshold it enforces, or a loosened value could pass
  // unnoticed by anyone reading the output.
  const metrics = computeMetrics([], {
    parseFailures: 0,
    malformed: 0,
    consistency: null,
    minActionShare: DEFAULT_THRESHOLDS.minActionShare,
  });
  for (const check of runChecks(metrics, DEFAULT_THRESHOLDS)) {
    assert.ok(check.required.length > 0, check.id);
    assert.ok(check.question.endsWith('?'), check.id);
  }
});

test('decisionCount matches what the harness actually decides', async () => {
  for (const stride of [1, 4, 7]) {
    const cfg = { ...options.cfg, stride };
    const run = await evaluate(brainOf('flat', constant('FLAT')), HOLDOUT, {
      ...options,
      cfg,
      consistencyProbes: 0,
    });
    assert.equal(run.metrics.decisions, decisionCount(CANDLES.length, cfg), `stride ${stride}`);
  }
});

test('--max-decisions trims the window to a prefix rather than sampling it', async () => {
  const full = await evaluate(brainOf('flat', constant('FLAT')), HOLDOUT, {
    ...options,
    consistencyProbes: 0,
  });
  const capped = await evaluate(brainOf('flat', constant('FLAT')), HOLDOUT, {
    ...options,
    consistencyProbes: 0,
    maxDecisions: 25,
  });

  assert.equal(capped.metrics.decisions, 25);
  assert.ok(capped.metrics.decisions < full.metrics.decisions);
});

test('WARMUP bars are never decided on, so no snapshot is built from thin history', async () => {
  const seen: number[] = [];
  const recording: DecideFn = async (s) => {
    seen.push(s.at);
    return decision('FLAT');
  };

  await evaluate(brainOf('recording', recording), HOLDOUT, { ...options, consistencyProbes: 0 });

  assert.equal(seen[0], CANDLES[WARMUP]!.closeTime);
  assert.ok(seen.at(-1)! <= CANDLES.at(-1 - DEFAULT_BACKTEST.horizon)!.closeTime);
});
