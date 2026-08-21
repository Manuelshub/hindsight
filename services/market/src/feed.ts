/**
 * Market data feed.
 *
 * Binance's public klines endpoint needs no API key. Responses are cached to disk so
 * backtests are reproducible and we are not re-fetching the same history on every run —
 * which matters, because a generation's training data must be pinned to exact bars.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Candle } from '../../../schemas/index.js';

/**
 * `data-api.binance.vision` is Binance's public market-data mirror: same klines schema,
 * no API key, and reachable from networks where the main api host is blocked. The main
 * host is kept as a fallback.
 */
const HOSTS = [
  'https://data-api.binance.vision/api/v3/klines',
  'https://api.binance.com/api/v3/klines',
];
/** Binance caps a single klines request at 1000 bars. */
const MAX_LIMIT = 1000;
const CACHE_DIR = join(process.cwd(), 'data', 'cache');

interface FetchOpts {
  symbol: string;
  interval: string;
  /** total bars wanted; paged automatically past the 1000-bar cap */
  limit: number;
  endTime?: number;
}

function cachePath({ symbol, interval, limit, endTime }: FetchOpts): string {
  const suffix = endTime ? `-${endTime}` : '-latest';
  return join(CACHE_DIR, `${symbol}-${interval}-${limit}${suffix}.json`);
}

/** Binance returns arrays of stringified numbers; index positions are fixed by the API. */
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
  endTime?: number,
): Promise<Candle[]> {
  const errors: string[] = [];

  for (const host of HOSTS) {
    const url = new URL(host);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        errors.push(`${url.host}: ${res.status} ${res.statusText}`);
        continue;
      }
      const rows = (await res.json()) as unknown[][];
      return rows.map(parseKline);
    } catch (err) {
      errors.push(`${url.host}: ${(err as Error).message}`);
    }
  }

  throw new Error(`all klines hosts failed for ${symbol} ${interval}\n  ${errors.join('\n  ')}`);
}

/**
 * Fetches `limit` candles ending at `endTime` (default: now), paging backwards through
 * Binance's 1000-bar cap. Results are ascending by time and cached on disk.
 */
export async function getCandles(opts: FetchOpts): Promise<Candle[]> {
  const path = cachePath(opts);
  if (existsSync(path)) {
    return JSON.parse(await readFile(path, 'utf8')) as Candle[];
  }

  const collected: Candle[] = [];
  let cursor = opts.endTime;

  while (collected.length < opts.limit) {
    const want = Math.min(MAX_LIMIT, opts.limit - collected.length);
    const page = await fetchPage(opts.symbol, opts.interval, want, cursor);
    if (page.length === 0) break;

    collected.unshift(...page);
    // step back one ms before the earliest bar we have, so pages do not overlap
    cursor = page[0]!.openTime - 1;

    if (page.length < want) break; // history exhausted
  }

  const candles = collected.slice(-opts.limit);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(candles));
  return candles;
}
