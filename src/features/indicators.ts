/**
 * Indicators and snapshot construction.
 *
 * Every function here takes the full candle array plus an index `i` and reads only
 * `[0..i]`. That constraint is what keeps look-ahead bias out of the training data —
 * if a snapshot could see past `i`, the whole "provable lineage" claim would be void.
 */
import type { Candle, Features, MarketSnapshot } from '../types.js';

/** Bars of history a snapshot needs before its features are well-defined. */
export const WARMUP = 50;

/**
 * Bumped whenever the feature set changes shape — a field added, removed, or reordered.
 *
 * Invariant I6: two generations are only comparable if they saw the same features. A
 * change here invalidates every earlier generation's results, so it must start a fresh
 * lineage rather than silently continuing the existing one.
 */
export const FEATURE_VERSION = 1;

/**
 * Bumped whenever `renderSnapshot` changes its output text, even cosmetically. That
 * string is the `input` field of every training example, so a change breaks
 * reproducibility (I4) and comparability (I6) at the same time.
 */
export const RENDERER_VERSION = 1;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Log return between two closes; safe against non-positive prices. */
export function logReturn(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return Math.log(to / from);
}

export function sma(candles: Candle[], i: number, period: number): number {
  const start = Math.max(0, i - period + 1);
  const window = candles.slice(start, i + 1).map((c) => c.close);
  return mean(window);
}

/** Wilder-smoothed RSI. Returns 50 (neutral) when there is not enough history. */
export function rsi(candles: Candle[], i: number, period = 14): number {
  if (i < period) return 50;

  let gain = 0;
  let loss = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const diff = candles[k]!.close - candles[k - 1]!.close;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;

  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** Average true range, simple-averaged over `period`. */
export function atr(candles: Candle[], i: number, period = 14): number {
  if (i < 1) return 0;
  const start = Math.max(1, i - period + 1);
  const trs: number[] = [];
  for (let k = start; k <= i; k++) {
    const c = candles[k]!;
    const prevClose = candles[k - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return mean(trs);
}

function returnsOver(candles: Candle[], i: number, lookback: number): number[] {
  const out: number[] = [];
  const start = Math.max(1, i - lookback + 1);
  for (let k = start; k <= i; k++) {
    out.push(logReturn(candles[k - 1]!.close, candles[k]!.close));
  }
  return out;
}

export function computeFeatures(candles: Candle[], i: number): Features {
  const close = candles[i]!.close;

  const a = atr(candles, i, 14);
  const sma24 = sma(candles, i, 24);

  const recentVol = stdev(returnsOver(candles, i, 24));
  const priorVol = stdev(returnsOver(candles, Math.max(0, i - 24), 24));

  const volWindow = candles.slice(Math.max(0, i - 23), i + 1).map((c) => c.volume);
  const meanVol = mean(volWindow);

  return {
    ret1: logReturn(candles[i - 1]?.close ?? close, close),
    ret6: logReturn(candles[i - 6]?.close ?? close, close),
    ret24: logReturn(candles[i - 24]?.close ?? close, close),
    // distance from trend expressed in volatility units, so it is comparable across regimes
    smaDist24: a > 0 ? (close - sma24) / a : 0,
    rsi14: rsi(candles, i, 14),
    atrPct14: close > 0 ? a / close : 0,
    volRatio24: meanVol > 0 ? candles[i]!.volume / meanVol : 1,
    volOfVol: priorVol > 0 ? recentVol / priorVol : 1,
  };
}

export function buildSnapshot(
  candles: Candle[],
  i: number,
  symbol: string,
  interval: string,
): MarketSnapshot {
  return {
    symbol,
    interval,
    at: candles[i]!.closeTime,
    close: candles[i]!.close,
    features: computeFeatures(candles, i),
  };
}

/**
 * Renders a snapshot as the compact text block the model sees. Kept deterministic and
 * stable: this exact string becomes the `input` field of training examples, so any
 * change to it invalidates comparisons against earlier generations.
 */
export function renderSnapshot(s: MarketSnapshot): string {
  const f = s.features;
  const pct = (x: number) => (x * 100).toFixed(2);
  return [
    `symbol: ${s.symbol}  interval: ${s.interval}`,
    `close: ${s.close.toFixed(2)}`,
    `return_1b: ${pct(f.ret1)}%`,
    `return_6b: ${pct(f.ret6)}%`,
    `return_24b: ${pct(f.ret24)}%`,
    `dist_from_sma24_in_atr: ${f.smaDist24.toFixed(2)}`,
    `rsi_14: ${f.rsi14.toFixed(1)}`,
    `atr_pct: ${pct(f.atrPct14)}%`,
    `volume_vs_24b_avg: ${f.volRatio24.toFixed(2)}x`,
    `vol_regime_shift: ${f.volOfVol.toFixed(2)}x`,
  ].join('\n');
}
