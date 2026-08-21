/**
 * Cuts the frozen held-out fixtures.
 *
 *   pnpm tsx evals/quality/build-holdout.ts [--symbol BTCUSDT] [--interval 1h] [--context 400]
 *
 * Run this, not the eval, when the network is allowed. It reads the real training
 * artefacts in `runs/`, works out the exact bars any generation has already seen, fetches
 * market data on the far side of that line from Binance's free public mirror, and writes
 * the candles plus a manifest recording where the line was drawn.
 *
 * Splitting it out this way is what makes the eval itself free and offline: the suite
 * never fetches anything, so it can be run on every commit against every baseline without
 * a network or a wallet.
 *
 * Two windows are cut, because forward and backward holdouts fail differently:
 *
 *  - `forward` — bars after the newest training bar. This is the one that matches the
 *    on-chain seal (invariant I2), and the only one whose result is evidence of anything.
 *    It is small by construction and grows by 24 bars a day.
 *  - `pre` — bars before the oldest training bar. Large enough for tight confidence
 *    intervals, and untouched by any generation. Weaker evidence, because the base model's
 *    own pretraining may have covered the period, so it is a diagnostic and not a claim.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Candle } from './harness/project.js';
import { DEFAULT_BACKTEST, getCandles } from './harness/project.js';
import { BAR_MS, EVALS_DIR, deriveTrainingBoundary, scoreableIndices } from './harness/holdout.js';
import type { HoldoutManifest, HoldoutWindowManifest, WindowRelation } from './harness/types.js';

interface Args {
  symbol: string;
  interval: string;
  /** Bars of feature warmup to include ahead of a forward window's first scored bar. */
  context: number;
  /** Total bars to pull for the pre-training window. */
  preBars: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    symbol: get('--symbol') ?? DEFAULT_BACKTEST.symbol,
    interval: get('--interval') ?? DEFAULT_BACKTEST.interval,
    context: Number(get('--context') ?? 400),
    preBars: Number(get('--pre-bars') ?? 1200),
  };
}

function describe(candles: Candle[]): { from: string; to: string } {
  return {
    from: new Date(candles[0]!.openTime).toISOString(),
    to: new Date(candles.at(-1)!.closeTime).toISOString(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const barMs = BAR_MS[args.interval];
  if (!barMs) throw new Error(`unsupported interval ${args.interval}`);

  const boundary = deriveTrainingBoundary('runs');
  if (!boundary) {
    throw new Error(
      'no training artefacts under runs/ — the holdout boundary cannot be derived, and a ' +
        'fixture cut without one would be held out from nothing',
    );
  }

  console.log('training data occupies');
  console.log(`  ${new Date(boundary.startAt).toISOString()} -> ${new Date(boundary.endAt).toISOString()}`);
  for (const source of boundary.sources) console.log(`  from ${source}`);

  const outDir = join(EVALS_DIR, 'data');
  mkdirSync(outDir, { recursive: true });
  const windows: HoldoutWindowManifest[] = [];

  const cut = async (
    name: string,
    relation: WindowRelation,
    limit: number,
    endTime?: number,
  ): Promise<void> => {
    const candles = await getCandles({
      symbol: args.symbol,
      interval: args.interval,
      limit,
      endTime,
    });
    const scoreable = scoreableIndices(candles, DEFAULT_BACKTEST.horizon, relation, boundary);
    const file = `holdout-${args.symbol}-${args.interval}-${name}.json`;
    writeFileSync(join(outDir, file), JSON.stringify(candles));

    const range = describe(candles);
    windows.push({ name, relation, file, candles: candles.length, scoreable: scoreable.length, ...range });
    console.log(`  ${name}: ${candles.length} candles, ${scoreable.length} scoreable  ${range.from} -> ${range.to}`);
  };

  console.log('\ncutting windows');

  // Enough context to cover WARMUP with room to spare, then everything since the boundary.
  const sinceBoundary = Math.ceil((Date.now() - boundary.endAt) / barMs);
  await cut('forward', 'after', sinceBoundary + args.context);

  // One millisecond before the earliest training bar, so the page cannot include it.
  await cut('pre', 'before', args.preBars, boundary.startAt - 1);

  const manifest: HoldoutManifest = {
    builtAt: new Date().toISOString(),
    symbol: args.symbol,
    interval: args.interval,
    barMs,
    training: boundary,
    windows,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${join(outDir, 'manifest.json')}`);
}

main().catch((err) => {
  console.error(`\nfailed: ${(err as Error).message}`);
  process.exit(1);
});
