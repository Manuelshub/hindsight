/**
 * Runs a baseline strategy over cached market data and prints its record.
 *
 *   tsx src/cli/backtest.ts [baseline] [symbol] [interval] [bars]
 *   tsx src/cli/backtest.ts momentum BTCUSDT 1h 2000
 */
import { getCandles } from '../services/market/src/feed.js';
import { BASELINES, type BaselineName } from '../services/agent/src/baseline.js';
import { computeStats, formatStats, runBacktest } from '../services/scoring/src/backtest.js';
import { DEFAULT_BACKTEST } from '../schemas/index.js';

async function main() {
  const [nameArg, symbolArg, intervalArg, barsArg] = process.argv.slice(2);

  const name = (nameArg ?? 'momentum') as BaselineName;
  const decide = BASELINES[name];
  if (!decide) {
    console.error(`unknown baseline "${name}". options: ${Object.keys(BASELINES).join(', ')}`);
    process.exit(1);
  }

  const cfg = {
    ...DEFAULT_BACKTEST,
    symbol: symbolArg ?? DEFAULT_BACKTEST.symbol,
    interval: intervalArg ?? DEFAULT_BACKTEST.interval,
  };
  const bars = Number(barsArg ?? 2000);

  console.log(`fetching ${bars} x ${cfg.interval} candles for ${cfg.symbol}...`);
  const candles = await getCandles({ symbol: cfg.symbol, interval: cfg.interval, limit: bars });

  const from = new Date(candles[0]!.openTime).toISOString().slice(0, 16);
  const to = new Date(candles.at(-1)!.closeTime).toISOString().slice(0, 16);
  console.log(`got ${candles.length} candles: ${from} -> ${to}\n`);

  const traces = await runBacktest(candles, decide, cfg);
  const stats = computeStats(traces, cfg);

  console.log(formatStats(stats));

  // How often was a decision even possible? If the market was flat the whole window,
  // a high FLAT accuracy is not skill.
  const hindsightCounts = traces.reduce<Record<string, number>>((acc, t) => {
    acc[t.outcome.hindsight] = (acc[t.outcome.hindsight] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n  market truth   L:${hindsightCounts.LONG ?? 0} ` +
      `S:${hindsightCounts.SHORT ?? 0} F:${hindsightCounts.FLAT ?? 0}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
