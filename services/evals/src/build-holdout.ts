/**
 * Cuts the frozen held-out fixtures.
 *
 *   pnpm eval:build-holdout [--symbol BTCUSDT] [--interval 1h] [--context 400]
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
 *
 * ## The shared cache
 *
 * `getCandles` memoises every page into `data/cache/`, which is shared with `pnpm backtest`
 * and with the training runs. A stray file there is not harmless: a contamination model
 * that treats the cache as training data will read it as evidence a generation saw those
 * bars. So this tool records what was in the cache before it ran and deletes anything it
 * added, leaving the directory exactly as it found it. `--keep-cache` opts out, for when
 * the fetch is slow and the fixture is being re-cut repeatedly.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Candle } from './project.js';
import { DEFAULT_BACKTEST, getCandles } from './project.js';
import { BAR_MS, EVALS_DIR, deriveTrainingBoundary, scoreableIndices } from './holdout.js';
import type { HoldoutManifest, HoldoutWindowManifest, WindowRelation } from './types.js';

/** Where `services/market/src/feed.ts` puts its pages. Mirrored, not imported: it is private. */
const SHARED_CACHE = join(process.cwd(), 'data', 'cache');

interface Args {
  symbol: string;
  interval: string;
  /** Bars of feature warmup to include ahead of a forward window's first scored bar. */
  context: number;
  /** Total bars to pull for the pre-training window. */
  preBars: number;
  keepCache: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${flag} expects a number, got "${raw}"`);
    return value;
  };
  return {
    symbol: get('--symbol') ?? DEFAULT_BACKTEST.symbol,
    interval: get('--interval') ?? DEFAULT_BACKTEST.interval,
    context: num('--context', 400),
    preBars: num('--pre-bars', 1200),
    keepCache: argv.includes('--keep-cache'),
  };
}

function cacheContents(): Set<string> {
  return existsSync(SHARED_CACHE) ? new Set(readdirSync(SHARED_CACHE)) : new Set();
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
  console.log(
    `  ${new Date(boundary.startAt).toISOString()} -> ${new Date(boundary.endAt).toISOString()}`,
  );
  for (const source of boundary.sources) console.log(`  from ${source}`);

  const cacheBefore = cacheContents();
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
    windows.push({
      name,
      relation,
      file,
      candles: candles.length,
      scoreable: scoreable.length,
      ...range,
    });
    console.log(
      `  ${name}: ${candles.length} candles, ${scoreable.length} scoreable  ` +
        `${range.from} -> ${range.to}`,
    );
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

  // Only files this process added, never one that was already there: the cache is shared,
  // and deleting somebody else's page would just move the damage.
  const added = [...cacheContents()].filter((f) => !cacheBefore.has(f));
  if (added.length === 0) return;
  if (args.keepCache) {
    console.log(`\nleft ${added.length} new file(s) in data/cache/ (--keep-cache):`);
    for (const f of added) console.log(`  ${f}`);
    return;
  }
  for (const f of added) rmSync(join(SHARED_CACHE, f));
  console.log(`\nremoved ${added.length} file(s) this run added to the shared data/cache/`);
}

main().catch((err) => {
  console.error(`\nfailed: ${(err as Error).message}`);
  process.exit(1);
});
