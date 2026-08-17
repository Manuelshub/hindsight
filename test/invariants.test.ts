/**
 * Invariant tests for code that already exists.
 *
 * I1 is the most valuable test in this repository. A look-ahead bug produces beautiful
 * results and is invisible in every metric — the only way to catch it is to prove
 * mechanically that the future cannot reach the past.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot, computeFeatures } from '../src/features/indicators.js';
import { scoreDecision } from '../src/sim/backtest.js';
import { DEFAULT_BACKTEST } from '../src/types.js';
import { makeCandles, rng } from './helpers.js';

describe('I1 — no look-ahead', () => {
  it('a snapshot is unchanged when any future candle is mutated', () => {
    const candles = makeCandles(300);
    const rand = rng(7);

    for (let trial = 0; trial < 25; trial++) {
      const i = 60 + Math.floor(rand() * 200);
      const before = JSON.stringify(buildSnapshot(candles, i, 'BTCUSDT', '1h'));

      // Corrupt every bar strictly after i.
      const mutated = candles.map((c, k) =>
        k > i ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low / 3, close: c.close * 3 }
              : c,
      );

      const after = JSON.stringify(buildSnapshot(mutated, i, 'BTCUSDT', '1h'));
      assert.equal(after, before, `snapshot at bar ${i} changed when future bars were mutated`);
    }
  });

  it('features depend on no candle beyond the requested index', () => {
    const candles = makeCandles(200);
    const i = 150;
    const truncated = candles.slice(0, i + 1);

    assert.deepEqual(
      computeFeatures(truncated, i),
      computeFeatures(candles, i),
      'truncating future bars changed the feature vector',
    );
  });
});

describe('I5 — cost realism', () => {
  const candles = makeCandles(200);
  const cfg = DEFAULT_BACKTEST;

  it('charges a cost on every LONG', () => {
    const outcome = scoreDecision(candles, 100, 'LONG', cfg);
    assert.equal(outcome.realizedReturn, outcome.forwardReturn - cfg.costPerTrade);
  });

  it('charges a cost on every SHORT', () => {
    const outcome = scoreDecision(candles, 100, 'SHORT', cfg);
    assert.equal(outcome.realizedReturn, -outcome.forwardReturn - cfg.costPerTrade);
  });

  it('FLAT earns and costs nothing', () => {
    const outcome = scoreDecision(candles, 100, 'FLAT', cfg);
    assert.equal(outcome.realizedReturn, 0);
  });

  it('never lets a directional trade keep the full move', () => {
    for (let i = 60; i < 150; i++) {
      for (const side of ['LONG', 'SHORT'] as const) {
        const outcome = scoreDecision(candles, i, side, cfg);
        assert.notEqual(outcome.realizedReturn, outcome.forwardReturn);
      }
    }
  });
});

describe('hindsight labelling', () => {
  const candles = makeCandles(200);

  it('labels moves inside the threshold as FLAT', () => {
    const cfg = { ...DEFAULT_BACKTEST, flatThreshold: 10 }; // nothing can exceed this
    for (let i = 60; i < 100; i++) {
      assert.equal(scoreDecision(candles, i, 'FLAT', cfg).hindsight, 'FLAT');
    }
  });

  it('labels any move as directional when the threshold is zero', () => {
    const cfg = { ...DEFAULT_BACKTEST, flatThreshold: 0 };
    for (let i = 60; i < 100; i++) {
      const outcome = scoreDecision(candles, i, 'FLAT', cfg);
      const expected = outcome.forwardReturn > 0 ? 'LONG' : outcome.forwardReturn < 0 ? 'SHORT' : 'FLAT';
      assert.equal(outcome.hindsight, expected);
    }
  });

  it('marks a decision correct exactly when it matches hindsight', () => {
    for (let i = 60; i < 120; i++) {
      for (const side of ['LONG', 'SHORT', 'FLAT'] as const) {
        const outcome = scoreDecision(candles, i, side, DEFAULT_BACKTEST);
        assert.equal(outcome.correct, side === outcome.hindsight);
      }
    }
  });
});
