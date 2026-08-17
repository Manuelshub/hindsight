/**
 * Domain model for Hindsight.
 *
 * The loop: observe -> decide -> wait -> score against what actually happened ->
 * keep the mistakes -> retrain on them -> new generation.
 */

export type Side = 'LONG' | 'SHORT' | 'FLAT';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Derived features — the only thing the model is allowed to see at decision time. */
export interface Features {
  /** log return over the last bar */
  ret1: number;
  /** log return over 6 bars */
  ret6: number;
  /** log return over 24 bars */
  ret24: number;
  /** close relative to its 24-bar SMA, in ATR units */
  smaDist24: number;
  /** RSI(14), 0..100 */
  rsi14: number;
  /** ATR(14) as a fraction of close — realised volatility proxy */
  atrPct14: number;
  /** current volume over 24-bar mean volume */
  volRatio24: number;
  /** realised vol of last 24 bars over that of the prior 24 — regime shift proxy */
  volOfVol: number;
}

/**
 * Everything known at decision time. Constructed only from bars at or before `at`,
 * so a snapshot can never leak the future into training data.
 */
export interface MarketSnapshot {
  symbol: string;
  interval: string;
  /** close time of the most recent completed bar */
  at: number;
  close: number;
  features: Features;
}

export interface Decision {
  action: Side;
  /** 0..1, self-reported by the model */
  confidence: number;
  /** short natural-language justification — kept for the audit trail, not for training */
  rationale: string;
  /** which generation of the agent produced this */
  generation: number;
  /** model identifier, e.g. "qwen/qwen2.5-omni-7b" or "gen3-lora" */
  model: string;
}

/** What actually happened after the decision. Filled in `horizon` bars later. */
export interface Outcome {
  /** log return from decision close to close `horizon` bars later */
  forwardReturn: number;
  /** return the decision actually earned, after costs — negative for a wrong-way bet */
  realizedReturn: number;
  /** the action that would have been correct, known only in hindsight */
  hindsight: Side;
  /** whether the decision matched hindsight */
  correct: boolean;
}

/**
 * One complete observation. This is the unit that gets written to 0G Storage and
 * later converted into training data.
 */
export interface Trace {
  id: string;
  snapshot: MarketSnapshot;
  decision: Decision;
  outcome: Outcome;
}

export interface BacktestConfig {
  symbol: string;
  interval: string;
  /** bars to look ahead when scoring a decision */
  horizon: number;
  /**
   * |forward return| below this is treated as noise and labelled FLAT, so the agent
   * is not trained to chase moves smaller than its own costs.
   */
  flatThreshold: number;
  /** round-trip cost as a fraction, applied to non-FLAT positions */
  costPerTrade: number;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  symbol: 'BTCUSDT',
  interval: '1h',
  horizon: 6,
  flatThreshold: 0.004,
  costPerTrade: 0.0006,
};

/** Aggregate scoring of a generation — what we register on-chain as its record. */
export interface GenerationStats {
  generation: number;
  model: string;
  traces: number;
  accuracy: number;
  /** mean realised return per decision, after costs */
  meanReturn: number;
  /** cumulative return compounding every decision */
  cumulativeReturn: number;
  /** mean return / stdev of returns, annualised against bars-per-year */
  sharpe: number;
  /** worst peak-to-trough drawdown of the equity curve */
  maxDrawdown: number;
  actionCounts: Record<Side, number>;
}
