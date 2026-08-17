/**
 * Paper-trading harness and hindsight scoring.
 *
 * No capital is ever at risk: decisions are scored against realised forward returns.
 * The point of this module is not profit, it is producing an honest, comparable record
 * for each generation of the agent.
 */
import type {
  BacktestConfig,
  Candle,
  Decision,
  GenerationStats,
  MarketSnapshot,
  Outcome,
  Side,
  Trace,
} from '../types.js';
import { WARMUP, buildSnapshot, logReturn } from '../features/indicators.js';

/** A decision function — the agent's brain for a given generation. */
export type DecideFn = (snapshot: MarketSnapshot) => Promise<Decision>;

const BARS_PER_YEAR: Record<string, number> = {
  '1m': 525_600,
  '5m': 105_120,
  '15m': 35_040,
  '1h': 8_760,
  '4h': 2_190,
  '1d': 365,
};

/**
 * Scores one decision against what the market actually did.
 *
 * `flatThreshold` matters: without it the agent learns to chase moves smaller than its
 * own trading costs, which looks like skill in-sample and loses money out of sample.
 */
export function scoreDecision(
  candles: Candle[],
  i: number,
  action: Side,
  cfg: BacktestConfig,
): Outcome {
  const exit = candles[i + cfg.horizon];
  if (!exit) throw new Error(`no bar at horizon for index ${i}`);

  const forwardReturn = logReturn(candles[i]!.close, exit.close);

  const hindsight: Side =
    forwardReturn > cfg.flatThreshold
      ? 'LONG'
      : forwardReturn < -cfg.flatThreshold
        ? 'SHORT'
        : 'FLAT';

  let realizedReturn: number;
  switch (action) {
    case 'LONG':
      realizedReturn = forwardReturn - cfg.costPerTrade;
      break;
    case 'SHORT':
      realizedReturn = -forwardReturn - cfg.costPerTrade;
      break;
    case 'FLAT':
      realizedReturn = 0;
      break;
  }

  return { forwardReturn, realizedReturn, hindsight, correct: action === hindsight };
}

/**
 * Runs `decide` across every scoreable bar and returns the full trace set.
 *
 * Bars before WARMUP have undefined features, and the last `horizon` bars cannot be
 * scored yet, so both ends are excluded.
 */
export async function runBacktest(
  candles: Candle[],
  decide: DecideFn,
  cfg: BacktestConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<Trace[]> {
  const first = WARMUP;
  const last = candles.length - cfg.horizon - 1;
  if (last <= first) {
    throw new Error(
      `not enough candles: need > ${WARMUP + cfg.horizon + 1}, got ${candles.length}`,
    );
  }

  const traces: Trace[] = [];
  const total = last - first + 1;

  for (let i = first; i <= last; i++) {
    const snapshot = buildSnapshot(candles, i, cfg.symbol, cfg.interval);
    const decision = await decide(snapshot);
    const outcome = scoreDecision(candles, i, decision.action, cfg);

    traces.push({
      id: `${cfg.symbol}-${cfg.interval}-${snapshot.at}-g${decision.generation}`,
      snapshot,
      decision,
      outcome,
    });

    onProgress?.(traces.length, total);
  }

  return traces;
}

function maxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 1;
  let worst = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

export function computeStats(traces: Trace[], cfg: BacktestConfig): GenerationStats {
  const n = traces.length;
  const actionCounts: Record<Side, number> = { LONG: 0, SHORT: 0, FLAT: 0 };
  const returns: number[] = [];
  let correct = 0;

  for (const t of traces) {
    actionCounts[t.decision.action]++;
    returns.push(t.outcome.realizedReturn);
    if (t.outcome.correct) correct++;
  }

  const meanReturn = n > 0 ? returns.reduce((a, b) => a + b, 0) / n : 0;

  const variance =
    n > 1 ? returns.reduce((acc, r) => acc + (r - meanReturn) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);

  // Annualised on one decision per bar. Overlapping horizons make consecutive returns
  // correlated, so treat this as a comparison metric between generations, not a
  // tradeable Sharpe.
  const perYear = BARS_PER_YEAR[cfg.interval] ?? 8_760;
  const sharpe = sd > 0 ? (meanReturn / sd) * Math.sqrt(perYear) : 0;

  let equity = 1;
  const curve: number[] = [];
  for (const r of returns) {
    equity *= Math.exp(r);
    curve.push(equity);
  }

  return {
    generation: traces[0]?.decision.generation ?? 0,
    model: traces[0]?.decision.model ?? 'unknown',
    traces: n,
    accuracy: n > 0 ? correct / n : 0,
    meanReturn,
    cumulativeReturn: equity - 1,
    sharpe,
    maxDrawdown: maxDrawdown(curve),
    actionCounts,
  };
}

export function formatStats(s: GenerationStats): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return [
    `generation ${s.generation}  (${s.model})`,
    `  decisions      ${s.traces}`,
    `  accuracy       ${pct(s.accuracy)}`,
    `  mean return    ${pct(s.meanReturn)} per decision`,
    `  cumulative     ${pct(s.cumulativeReturn)}`,
    `  sharpe         ${s.sharpe.toFixed(2)}`,
    `  max drawdown   ${pct(s.maxDrawdown)}`,
    `  actions        L:${s.actionCounts.LONG} S:${s.actionCounts.SHORT} F:${s.actionCounts.FLAT}`,
  ].join('\n');
}
