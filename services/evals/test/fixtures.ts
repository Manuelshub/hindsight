/**
 * Synthetic inputs for the eval suite's own tests.
 *
 * The walk is generated here rather than pulled from `schemas/fixtures.ts` because these
 * tests need windows of a specific size relative to the power floor, and a fixture whose
 * shape is owned elsewhere would silently change what they are asserting.
 */
import type { Candle } from '../src/project.js';
import type { Holdout, HoldoutManifest, WindowRelation } from '../src/types.js';
import { rng } from '../src/rng.js';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/** Seeded random walk, hourly bars. */
export function makeCandles(n: number, seed = 7, startPrice = 60_000): Candle[] {
  const rand = rng(seed);
  const candles: Candle[] = [];
  let price = startPrice;

  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + (rand() - 0.5) * 0.02);
    candles.push({
      openTime: T0 + i * HOUR,
      open,
      high: Math.max(open, close) * (1 + rand() * 0.004),
      low: Math.min(open, close) * (1 - rand() * 0.004),
      close,
      volume: 100 + rand() * 900,
      closeTime: T0 + (i + 1) * HOUR - 1,
    });
    price = close;
  }
  return candles;
}

export function makeManifest(startAt: number, endAt: number): HoldoutManifest {
  return {
    builtAt: '2026-01-01T00:00:00.000Z',
    symbol: 'BTCUSDT',
    interval: '1h',
    barMs: HOUR,
    training: { startAt, endAt, sources: ['fixture'] },
    windows: [
      {
        name: 'fixture',
        relation: 'after',
        file: 'fixture.json',
        candles: 0,
        scoreable: 0,
        from: '',
        to: '',
      },
    ],
  };
}

/**
 * A window with no training data anywhere near it, so a test can exercise the runner
 * without also exercising the boundary logic.
 */
export function makeHoldout(candles: Candle[], scoreable: number[]): Holdout {
  const relation: WindowRelation = 'after';
  return {
    name: 'fixture',
    relation,
    manifest: makeManifest(0, T0 - 1),
    candles,
    scoreable,
  };
}
