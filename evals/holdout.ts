/**
 * The held-out window, and the proof that it is held out.
 *
 * An eval that scores a fine-tuned model on bars it was trained on measures memorisation
 * and calls it skill. This module makes that mistake structurally hard: the window ships
 * as a pinned file, and every run re-derives the set of bars the agent could have seen
 * from the repository itself and refuses to score if the two intersect.
 *
 * Disjointness is checked against the whole candle file, not just the bars a decision is
 * taken on. Warm-up context and the forward bars used for scoring are inputs to the
 * result too, and a window that only *mostly* misses the training data is not a held-out
 * window.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Candle } from '../src/types.js';
import { HoldoutIntegrityError } from './exit-codes.js';

/** A half-open-in-spirit interval of market time the agent may have been trained on. */
export interface ExcludedWindow {
  label: string;
  /** epoch ms of the first bar's open */
  from: number;
  /** epoch ms of the last bar's close */
  to: number;
}

export interface Holdout {
  schemaVersion: number;
  symbol: string;
  interval: string;
  /** When the file was produced. Only provenance; nothing reads it. */
  generatedAt: string;
  source: string;
  /**
   * The windows known to be contaminated at the time the file was cut. Pinned so the
   * guarantee survives someone deleting data/cache, and unioned with whatever the
   * verifier finds on disk today.
   */
  excluded: ExcludedWindow[];
  candles: Candle[];
}

export const DEFAULT_HOLDOUT = 'evals/data/BTCUSDT-1h-holdout.json';

export async function loadHoldout(path: string): Promise<Holdout> {
  if (!existsSync(path)) {
    throw new HoldoutIntegrityError(
      `no held-out window at ${path} — regenerate it with:\n` +
        '  pnpm tsx evals/fetch-holdout.ts',
    );
  }

  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Holdout>;
  const candles = parsed.candles ?? [];

  if (parsed.schemaVersion !== 1) {
    throw new HoldoutIntegrityError(`${path}: unsupported schemaVersion ${parsed.schemaVersion}`);
  }
  if (candles.length === 0) {
    throw new HoldoutIntegrityError(`${path}: no candles`);
  }
  if (!parsed.symbol || !parsed.interval) {
    throw new HoldoutIntegrityError(`${path}: missing symbol/interval`);
  }

  // Ascending, gap-free-in-ordering bars are assumed by every index-based indicator in
  // src/features. A shuffled file would produce plausible numbers from nonsense.
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.openTime <= candles[i - 1]!.openTime) {
      throw new HoldoutIntegrityError(`${path}: candles are not strictly ascending at index ${i}`);
    }
  }

  return {
    schemaVersion: 1,
    symbol: parsed.symbol,
    interval: parsed.interval,
    generatedAt: parsed.generatedAt ?? 'unknown',
    source: parsed.source ?? 'unknown',
    excluded: parsed.excluded ?? [],
    candles,
  };
}

function isoMinuteToMs(stamp: string, endOfMinute: boolean): number {
  // run stats record windows truncated to the minute; treat the closing stamp as the end
  // of its minute so a 59-second sliver of overlap cannot slip through.
  const suffix = endOfMinute ? ':59.999Z' : ':00.000Z';
  return Date.parse(`${stamp}${suffix}`);
}

interface RunStats {
  window?: { from?: string; to?: string };
  config?: { symbol?: string; interval?: string };
}

/**
 * Rebuilds the contaminated set from what is actually on disk right now.
 *
 * Two sources, because training data can be traced two ways: `runs/<gen>/stats.json` records
 * the window a generation was scored and curriculum-built over, and `data/cache` holds
 * every candle set anyone has ever pulled for this repo. Anything either of them touched
 * is off limits, whether or not it made it into a dataset.
 */
export async function discoverExcluded(
  repoRoot: string,
  symbol: string,
  interval: string,
): Promise<ExcludedWindow[]> {
  const found: ExcludedWindow[] = [];

  const runsDir = join(repoRoot, 'runs');
  if (existsSync(runsDir)) {
    for (const entry of await readdir(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statsPath = join(runsDir, entry.name, 'stats.json');
      if (!existsSync(statsPath)) continue;

      const stats = JSON.parse(await readFile(statsPath, 'utf8')) as RunStats;
      const from = stats.window?.from;
      const to = stats.window?.to;
      if (!from || !to) continue;
      if (stats.config?.symbol !== symbol || stats.config?.interval !== interval) continue;

      found.push({
        label: `runs/${entry.name}/stats.json`,
        from: isoMinuteToMs(from, false),
        to: isoMinuteToMs(to, true),
      });
    }
  }

  const cacheDir = join(repoRoot, 'data', 'cache');
  if (existsSync(cacheDir)) {
    const prefix = `${symbol}-${interval}-`;
    for (const file of await readdir(cacheDir)) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;

      const candles = JSON.parse(await readFile(join(cacheDir, file), 'utf8')) as Candle[];
      if (candles.length === 0) continue;

      found.push({
        label: `data/cache/${basename(file)}`,
        from: candles[0]!.openTime,
        to: candles.at(-1)!.closeTime,
      });
    }
  }

  return found;
}

export interface IntegrityReport {
  /** Every window the holdout was checked against, pinned plus discovered. */
  checkedAgainst: ExcludedWindow[];
  windowFrom: number;
  windowTo: number;
  bars: number;
}

/**
 * Throws unless every bar in the holdout falls outside every contaminated window.
 *
 * Throwing rather than flagging is deliberate: a caller that forgets to read a boolean
 * publishes an in-sample number as out-of-sample, and that is the one failure this
 * project cannot afford (spec §4, I2).
 */
export function assertHeldOut(holdout: Holdout, discovered: ExcludedWindow[]): IntegrityReport {
  // The pinned list and the discovered list normally describe the same windows; showing
  // each twice makes the proof harder to read, not more convincing.
  const checkedAgainst = dedupe([...holdout.excluded, ...discovered]);
  const first = holdout.candles[0]!;
  const last = holdout.candles.at(-1)!;

  for (const window of checkedAgainst) {
    if (!Number.isFinite(window.from) || !Number.isFinite(window.to)) {
      throw new HoldoutIntegrityError(`unparseable exclusion window "${window.label}"`);
    }
    const overlaps = first.openTime <= window.to && last.closeTime >= window.from;
    if (overlaps) {
      throw new HoldoutIntegrityError(
        `held-out window ${iso(first.openTime)}..${iso(last.closeTime)} overlaps ` +
          `"${window.label}" (${iso(window.from)}..${iso(window.to)}) — ` +
          'these bars may have been trained on, so no result from them is out-of-sample',
      );
    }
  }

  return {
    checkedAgainst,
    windowFrom: first.openTime,
    windowTo: last.closeTime,
    bars: holdout.candles.length,
  };
}

function dedupe(windows: ExcludedWindow[]): ExcludedWindow[] {
  const seen = new Map<string, ExcludedWindow>();
  for (const w of windows) {
    const key = `${w.label}:${w.from}:${w.to}`;
    if (!seen.has(key)) seen.set(key, w);
  }
  return [...seen.values()].sort((a, b) => a.from - b.from || a.label.localeCompare(b.label));
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}
