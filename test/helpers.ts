/**
 * Deterministic fixtures. Everything here is seeded so a failing test fails the same way
 * on every machine.
 */
import type { Candle, Decision, MarketSnapshot, Outcome, Side, Trace } from '../src/types.js';

/** Small, fast, seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic hourly candles following a seeded random walk. */
export function makeCandles(n: number, seed = 42, startPrice = 60_000): Candle[] {
  const rand = rng(seed);
  const candles: Candle[] = [];
  let price = startPrice;
  const hour = 3_600_000;
  const t0 = 1_700_000_000_000;

  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * 0.02;
    const open = price;
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + rand() * 0.004);
    const low = Math.min(open, close) * (1 - rand() * 0.004);
    candles.push({
      openTime: t0 + i * hour,
      open,
      high,
      low,
      close,
      volume: 100 + rand() * 900,
      closeTime: t0 + (i + 1) * hour - 1,
    });
    price = close;
  }
  return candles;
}

export function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    at: 1_700_000_000_000,
    close: 60_000,
    features: {
      ret1: 0.001,
      ret6: 0.004,
      ret24: -0.002,
      smaDist24: 0.8,
      rsi14: 55,
      atrPct14: 0.006,
      volRatio24: 1.2,
      volOfVol: 1.05,
      ...overrides.features,
    },
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'FLAT',
    confidence: 0.5,
    rationale: 'fixture',
    generation: 0,
    model: 'fixture-model',
    ...overrides,
  };
}

export function makeOutcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    forwardReturn: 0.01,
    realizedReturn: 0.0094,
    hindsight: 'LONG',
    correct: false,
    ...overrides,
  };
}

/**
 * Builds a trace with an explicit (said, truth) pair — the shape curriculum tests need.
 */
export function makeTrace(said: Side, truth: Side, index = 0): Trace {
  const at = 1_700_000_000_000 + index * 3_600_000;
  return {
    id: `BTCUSDT-1h-${at}-g0`,
    snapshot: makeSnapshot({ at, close: 60_000 + index }),
    decision: makeDecision({ action: said }),
    outcome: makeOutcome({ hindsight: truth, correct: said === truth }),
  };
}

/** `makeTraces([['LONG','SHORT'], ...])` — each pair is (what it said, what was true). */
export function makeTraces(pairs: Array<[Side, Side]>): Trace[] {
  return pairs.map(([said, truth], i) => makeTrace(said, truth, i));
}

/** N traces that are all wrong, cycling through the action space. */
export function makeMistakes(n: number): Trace[] {
  const sides: Side[] = ['LONG', 'SHORT', 'FLAT'];
  return Array.from({ length: n }, (_, i) => {
    const said = sides[i % 3]!;
    const truth = sides[(i + 1) % 3]!;
    return makeTrace(said, truth, i);
  });
}
