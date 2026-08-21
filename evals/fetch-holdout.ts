/**
 * Cuts a fresh held-out candle window and vendors it under evals/data.
 *
 *   pnpm tsx evals/fetch-holdout.ts [--symbol S] [--interval I] [--bars N] [--out PATH]
 *
 * This is the only part of the eval suite that touches the network, and it is run by hand
 * when the window needs to move — never as part of `pnpm eval`. Keeping the bars in the
 * repo is what makes the suite free, offline and byte-reproducible.
 *
 * It deliberately does not reuse src/market/feed.ts. That helper caches into data/cache,
 * and the disjointness verifier treats every file in data/cache as a window the agent may
 * have trained on. Fetching through it would make the eval declare its own data
 * contaminated the moment it was written.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Candle } from '../src/types.js';
import { DEFAULT_HOLDOUT, discoverExcluded, iso, type ExcludedWindow } from './holdout.js';

const HOSTS = [
  'https://data-api.binance.vision/api/v3/klines',
  'https://api.binance.com/api/v3/klines',
];
const MAX_LIMIT = 1000;

function parseKline(row: unknown[]): Candle {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  };
}

async function fetchPage(
  symbol: string,
  interval: string,
  limit: number,
  endTime: number,
): Promise<Candle[]> {
  const errors: string[] = [];

  for (const host of HOSTS) {
    const url = new URL(host);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));
    url.searchParams.set('endTime', String(endTime));

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        errors.push(`${url.host}: ${res.status} ${res.statusText}`);
        continue;
      }
      return ((await res.json()) as unknown[][]).map(parseKline);
    } catch (err) {
      errors.push(`${url.host}: ${(err as Error).message}`);
    }
  }

  throw new Error(`all klines hosts failed\n  ${errors.join('\n  ')}`);
}

/** Earliest bar open across every contaminated window; the holdout must end before it. */
function earliestExclusion(windows: ExcludedWindow[]): number | undefined {
  const starts = windows.map((w) => w.from).filter((t) => Number.isFinite(t));
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const symbol = arg(argv, '--symbol') ?? 'BTCUSDT';
  const interval = arg(argv, '--interval') ?? '1h';
  const bars = Number(arg(argv, '--bars') ?? 2000);
  const out = arg(argv, '--out') ?? DEFAULT_HOLDOUT;

  const excluded = await discoverExcluded(process.cwd(), symbol, interval);
  if (excluded.length === 0) {
    throw new Error(
      'found no training windows to hold out from — refusing to cut a window whose ' +
        'disjointness cannot be established',
    );
  }

  const boundary = earliestExclusion(excluded)!;
  console.log(`known training windows for ${symbol} ${interval}:`);
  for (const w of excluded) console.log(`  ${iso(w.from)} -> ${iso(w.to)}  ${w.label}`);

  // Take the window immediately *before* everything the agent has seen. Cutting forward
  // instead would mean re-fetching on every run as new bars close, which trades the
  // suite's reproducibility for a freshness nobody asked for — the forward, sealed
  // evaluation is the chain's job (spec §7.5), not this suite's.
  console.log(`\ncutting ${bars} bars ending before ${iso(boundary)}`);

  const collected: Candle[] = [];
  let cursor = boundary - 1;
  while (collected.length < bars) {
    const want = Math.min(MAX_LIMIT, bars - collected.length);
    const page = await fetchPage(symbol, interval, want, cursor);
    if (page.length === 0) break;
    collected.unshift(...page);
    cursor = page[0]!.openTime - 1;
    if (page.length < want) break;
  }

  const candles = collected.filter((c) => c.closeTime < boundary).slice(-bars);
  if (candles.length < bars) {
    console.log(`  warning: only ${candles.length} bars available`);
  }

  const holdout = {
    schemaVersion: 1,
    symbol,
    interval,
    generatedAt: new Date().toISOString(),
    source: 'binance klines (public market-data mirror)',
    excluded,
    candles,
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(holdout, null, 0)}\n`);

  console.log(
    `\nwrote ${out}: ${candles.length} bars ` +
      `${iso(candles[0]!.openTime)} -> ${iso(candles.at(-1)!.closeTime)}`,
  );
}

main().catch((err) => {
  console.error(`\nfailed: ${(err as Error).message}`);
  process.exit(1);
});
