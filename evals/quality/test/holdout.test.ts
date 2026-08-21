/**
 * The separation guarantee.
 *
 * These are the tests that stand behind the claim "this window is held out". Everything
 * else in the suite measures a brain; this measures whether the measurement is allowed to
 * count. A bug here does not make the numbers wrong — it makes them meaningless, silently,
 * which is worse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WARMUP } from '../harness/project.js';
import { isHeldOut, scoreableIndices } from '../harness/holdout.js';
import type { TrainingBoundary } from '../harness/holdout.js';
import { makeCandles } from './fixtures.js';

const HORIZON = 6;
const candles = makeCandles(200);

/** Boundary drawn mid-window, so both sides of every rule are exercised. */
function boundaryAt(index: number): TrainingBoundary {
  return {
    startAt: candles[index]!.closeTime,
    endAt: candles[index]!.closeTime,
    sources: ['test'],
  };
}

describe('isHeldOut', () => {
  const boundary = boundaryAt(100);

  it('excludes a bar closing exactly on the boundary, in both directions', () => {
    assert.equal(isHeldOut(boundary.endAt, 'after', boundary), false);
    assert.equal(isHeldOut(boundary.startAt, 'before', boundary), false);
  });

  it('admits a bar one millisecond clear of the boundary', () => {
    assert.ok(isHeldOut(boundary.endAt + 1, 'after', boundary));
    assert.ok(isHeldOut(boundary.startAt - 1, 'before', boundary));
  });
});

describe('scoreableIndices', () => {
  it('never returns a bar at or before the boundary for an "after" window', () => {
    const boundary = boundaryAt(120);
    for (const i of scoreableIndices(candles, HORIZON, 'after', boundary)) {
      assert.ok(candles[i]!.closeTime > boundary.endAt, `bar ${i} is inside the training window`);
    }
  });

  it('excludes a bar whose exit lands inside the training window', () => {
    // A "before" window's last few bars are graded from closes that sit past the boundary,
    // so the decision bar clearing it is not enough.
    const boundary = boundaryAt(120);
    for (const i of scoreableIndices(candles, HORIZON, 'before', boundary)) {
      assert.ok(
        candles[i + HORIZON]!.closeTime < boundary.startAt,
        `bar ${i} is graded from a close inside the training window`,
      );
    }
  });

  it('leaves exactly a horizon-sized gap below a "before" boundary', () => {
    const cut = 120;
    const indices = scoreableIndices(candles, HORIZON, 'before', boundaryAt(cut));
    assert.equal(indices.at(-1), cut - HORIZON - 1);
  });

  it('honours feature warmup at the start of the window', () => {
    const boundary = { startAt: 0, endAt: 0, sources: [] };
    assert.equal(scoreableIndices(candles, HORIZON, 'after', boundary)[0], WARMUP);
  });

  it('returns nothing when the boundary swallows the whole window', () => {
    const boundary = boundaryAt(candles.length - 1);
    assert.deepEqual(scoreableIndices(candles, HORIZON, 'after', boundary), []);
  });

  it('never returns a bar without a scoreable exit', () => {
    const boundary = { startAt: 0, endAt: 0, sources: [] };
    for (const i of scoreableIndices(candles, HORIZON, 'after', boundary)) {
      assert.ok(candles[i + HORIZON] !== undefined);
    }
  });
});
