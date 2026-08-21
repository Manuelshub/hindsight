/**
 * Held-out window loading, and the guarantee that it is actually held out.
 *
 * The project's whole claim rests on invariant I2 — a generation may only be graded on
 * bars it could not have seen. The on-chain registry enforces that for sealed results.
 * This suite runs constantly and off-chain, so it enforces the same separation itself,
 * from evidence rather than from good intentions:
 *
 *  1. `build-holdout.ts` derives the training boundary from the real artefacts in
 *     `runs/` — every trace's bar, every stats window — and freezes it into the manifest.
 *  2. Every eval run re-checks each scored bar against that frozen boundary.
 *  3. When `runs/` is present, the boundary is re-derived live and compared. A generation
 *     trained on newer data than the fixture was cut against fails the run instead of
 *     quietly grading itself on its own training set.
 *
 * Step 3 is the one that matters. `runs/` is gitignored, so step 1 alone would be a claim
 * with no way to falsify it after the fact.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle, Trace } from './project.js';
import { WARMUP } from './project.js';
import type { Holdout, HoldoutManifest, WindowRelation } from './types.js';

export const EVALS_DIR = new URL('..', import.meta.url).pathname;
export const MANIFEST_PATH = join(EVALS_DIR, 'data', 'manifest.json');

export const BAR_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export class HoldoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutError';
  }
}

export interface TrainingBoundary {
  startAt: number;
  endAt: number;
  sources: string[];
}

/**
 * Widens a boundary to cover a run directory.
 *
 * Both ends are padded rather than taken literally. A trace at bar `i` was labelled from
 * the close of bar `i + horizon`, so the run saw further forward than its last snapshot
 * time admits; and its features read `WARMUP` bars further back than its first. Taking
 * the raw min and max would leave a horizon-sized sliver of training data inside the
 * "held-out" window.
 */
function widenFromRun(dir: string, boundary: TrainingBoundary): void {
  const tracesPath = join(dir, 'traces.jsonl');
  const statsPath = join(dir, 'stats.json');

  if (existsSync(tracesPath)) {
    let horizon = 0;
    let barMs = BAR_MS['1h']!;
    if (existsSync(statsPath)) {
      const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as {
        config?: { horizon?: number; interval?: string };
      };
      horizon = stats.config?.horizon ?? 0;
      barMs = BAR_MS[stats.config?.interval ?? '1h'] ?? barMs;
    }

    for (const line of readFileSync(tracesPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const trace = JSON.parse(line) as Trace;
      boundary.startAt = Math.min(boundary.startAt, trace.snapshot.at - WARMUP * barMs);
      boundary.endAt = Math.max(boundary.endAt, trace.snapshot.at + horizon * barMs);
    }
    boundary.sources.push(tracesPath);
  }

  // The stats window is the candle range the run was handed, which is wider still than
  // anything the traces reveal.
  if (existsSync(statsPath)) {
    const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as {
      window?: { from?: string; to?: string };
    };
    const from = stats.window?.from ? Date.parse(`${stats.window.from}:00Z`) : NaN;
    const to = stats.window?.to ? Date.parse(`${stats.window.to}:59.999Z`) : NaN;
    if (Number.isFinite(from)) boundary.startAt = Math.min(boundary.startAt, from);
    if (Number.isFinite(to)) boundary.endAt = Math.max(boundary.endAt, to);
    boundary.sources.push(statsPath);
  }
}

/**
 * Derives the training boundary from every generation directory on disk.
 *
 * Returns null when `runs/` is absent — a fresh clone has no artefacts to check against,
 * which is why the manifest exists.
 */
export function deriveTrainingBoundary(runsDir = 'runs'): TrainingBoundary | null {
  if (!existsSync(runsDir)) return null;

  const boundary: TrainingBoundary = {
    startAt: Number.POSITIVE_INFINITY,
    endAt: Number.NEGATIVE_INFINITY,
    sources: [],
  };

  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^gen-\d+$/.test(entry.name)) {
      widenFromRun(join(runsDir, entry.name), boundary);
    }
  }

  return boundary.sources.length > 0 ? boundary : null;
}

export function readManifest(path = MANIFEST_PATH): HoldoutManifest {
  if (!existsSync(path)) {
    throw new HoldoutError(
      `no holdout manifest at ${path} — build one with:\n` +
        '  pnpm tsx evals/quality/build-holdout.ts',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as HoldoutManifest;
}

/** True when a bar at `closeTime` sits on the safe side of the boundary. */
export function isHeldOut(
  closeTime: number,
  relation: WindowRelation,
  boundary: TrainingBoundary,
): boolean {
  return relation === 'after' ? closeTime > boundary.endAt : closeTime < boundary.startAt;
}

/**
 * Selects the bars a window may score.
 *
 * Both the decision bar and the bar its label is read from must clear the boundary. Only
 * checking the decision bar would let a decision near the edge be graded against a close
 * that sits inside the training window.
 *
 * Feature warmup is treated differently on purpose. A snapshot reads the `WARMUP` bars
 * before it, and for an `after` window those bars are pre-boundary by construction. That
 * is context, not leakage: the brain is being asked what happens next given history it
 * was always going to have. What it must never see is the answer.
 */
export function scoreableIndices(
  candles: Candle[],
  horizon: number,
  relation: WindowRelation,
  boundary: TrainingBoundary,
): number[] {
  const out: number[] = [];
  for (let i = WARMUP; i <= candles.length - horizon - 1; i++) {
    const decisionBar = candles[i]!;
    const exitBar = candles[i + horizon]!;
    if (
      isHeldOut(decisionBar.closeTime, relation, boundary) &&
      isHeldOut(exitBar.closeTime, relation, boundary)
    ) {
      out.push(i);
    }
  }
  return out;
}

export interface LoadOptions {
  window: string;
  horizon: number;
  manifestPath?: string;
  runsDir?: string;
}

/**
 * Loads a window and refuses to return one that cannot be trusted.
 *
 * Throws `HoldoutError` for every failure here, which the CLI maps to its own exit code:
 * a compromised window is not a verdict on the brain and must never be reported as one.
 */
export function loadHoldout(options: LoadOptions): Holdout {
  const manifest = readManifest(options.manifestPath);
  const spec = manifest.windows.find((w) => w.name === options.window);
  if (!spec) {
    const names = manifest.windows.map((w) => w.name).join(', ');
    throw new HoldoutError(`unknown window "${options.window}" — manifest has: ${names}`);
  }

  const path = join(EVALS_DIR, 'data', spec.file);
  if (!existsSync(path)) {
    throw new HoldoutError(`manifest lists ${spec.file} but ${path} is missing`);
  }
  const candles = JSON.parse(readFileSync(path, 'utf8')) as Candle[];

  const frozen: TrainingBoundary = {
    startAt: manifest.training.startAt,
    endAt: manifest.training.endAt,
    sources: manifest.training.sources,
  };

  // The live artefacts win when they disagree. A generation trained on data newer than
  // the fixture would otherwise be graded on its own training set.
  const live = deriveTrainingBoundary(options.runsDir ?? 'runs');
  const boundary: TrainingBoundary = live
    ? {
        startAt: Math.min(frozen.startAt, live.startAt),
        endAt: Math.max(frozen.endAt, live.endAt),
        sources: [...new Set([...frozen.sources, ...live.sources])],
      }
    : frozen;

  if (live && (live.endAt > frozen.endAt || live.startAt < frozen.startAt)) {
    throw new HoldoutError(
      `training data on disk has moved past the frozen holdout boundary\n` +
        `  manifest: ${new Date(frozen.startAt).toISOString()} .. ${new Date(frozen.endAt).toISOString()}\n` +
        `  on disk:  ${new Date(live.startAt).toISOString()} .. ${new Date(live.endAt).toISOString()}\n` +
        `  rebuild the fixture: pnpm tsx evals/quality/build-holdout.ts`,
    );
  }

  const scoreable = scoreableIndices(candles, options.horizon, spec.relation, boundary);

  return { name: spec.name, relation: spec.relation, manifest, candles, scoreable };
}
