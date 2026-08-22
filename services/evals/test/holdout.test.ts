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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WARMUP } from '../src/project.js';
import { HoldoutError, isHeldOut, loadHoldout, scoreableIndices } from '../src/holdout.js';
import type { TrainingBoundary } from '../src/holdout.js';
import { makeCandles, makeManifest } from './fixtures.js';

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

describe('loadHoldout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdout-'));
  const manifestPath = join(dir, 'manifest.json');

  function write(training: { startAt: number; endAt: number }, runs?: number): void {
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(candles));
    const manifest = makeManifest(training.startAt, training.endAt);
    manifest.windows[0]!.file = 'fixture.json';
    writeFileSync(manifestPath, JSON.stringify(manifest));

    if (runs !== undefined) {
      const runDir = join(dir, 'runs', 'gen-0');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'stats.json'),
        JSON.stringify({
          config: { horizon: HORIZON, interval: '1h' },
          window: {
            from: new Date(candles[0]!.openTime).toISOString().slice(0, 16),
            to: new Date(candles[runs]!.closeTime).toISOString().slice(0, 16),
          },
        }),
      );
    }
  }

  it('loads a window whose fixture sits beside its manifest', () => {
    write({ startAt: 0, endAt: candles[100]!.closeTime });
    const holdout = loadHoldout({ window: 'fixture', horizon: HORIZON, manifestPath, runsDir: dir });
    assert.ok(holdout.scoreable.length > 0);
    assert.ok(holdout.scoreable.every((i) => candles[i]!.closeTime > candles[100]!.closeTime));
  });

  it('rejects a window the manifest does not describe', () => {
    write({ startAt: 0, endAt: candles[100]!.closeTime });
    assert.throws(
      () => loadHoldout({ window: 'ghost', horizon: HORIZON, manifestPath, runsDir: dir }),
      HoldoutError,
    );
  });

  /**
   * The check that makes the separation claim falsifiable. A generation trained on data
   * newer than the frozen fixture would otherwise be graded on its own training set, and
   * every number the suite printed would be a lie told with a straight face.
   */
  it('refuses to run when training data on disk has passed the frozen boundary', () => {
    write({ startAt: 0, endAt: candles[100]!.closeTime }, 150);
    assert.throws(
      () => loadHoldout({ window: 'fixture', horizon: HORIZON, manifestPath, runsDir: join(dir, 'runs') }),
      /training data on disk has moved past/,
    );
  });
});
