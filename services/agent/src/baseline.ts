/**
 * Deterministic baselines — generation -1.
 *
 * These exist to keep everything honest. An LLM agent that cannot beat a two-line
 * momentum rule has not learned anything, and "generation 7 beat generation 1" means
 * nothing without a fixed control to measure both against.
 */
import type { Decision, MarketSnapshot, Side } from '../../../schemas/index.js';

/** Always FLAT. The true zero: what you get for taking no risk at all. */
export const alwaysFlat = async (_s: MarketSnapshot): Promise<Decision> => ({
  action: 'FLAT',
  confidence: 1,
  rationale: 'baseline: never trades',
  generation: -1,
  model: 'baseline-flat',
});

/** Trend following: side with the recent move when price is stretched from its mean. */
export const momentum = async (s: MarketSnapshot): Promise<Decision> => {
  const { smaDist24, ret6 } = s.features;

  let action: Side = 'FLAT';
  if (smaDist24 > 0.5 && ret6 > 0) action = 'LONG';
  else if (smaDist24 < -0.5 && ret6 < 0) action = 'SHORT';

  return {
    action,
    confidence: Math.min(1, Math.abs(smaDist24) / 2),
    rationale: `momentum: smaDist=${smaDist24.toFixed(2)} ret6=${(ret6 * 100).toFixed(2)}%`,
    generation: -1,
    model: 'baseline-momentum',
  };
};

/** Mean reversion: fade RSI extremes. The natural opponent of the momentum rule. */
export const meanReversion = async (s: MarketSnapshot): Promise<Decision> => {
  const { rsi14 } = s.features;

  let action: Side = 'FLAT';
  if (rsi14 > 70) action = 'SHORT';
  else if (rsi14 < 30) action = 'LONG';

  return {
    action,
    confidence: Math.min(1, Math.abs(rsi14 - 50) / 50),
    rationale: `mean-reversion: rsi=${rsi14.toFixed(1)}`,
    generation: -1,
    model: 'baseline-mean-reversion',
  };
};

export const BASELINES = {
  flat: alwaysFlat,
  momentum,
  'mean-reversion': meanReversion,
} as const;

export type BaselineName = keyof typeof BASELINES;
