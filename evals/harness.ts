/**
 * Runs any DecideFn over the held-out window and turns it into a graded report.
 *
 * The harness knows nothing about which brain it is holding. It sees the DecideFn
 * contract and nothing else, which is the only way a baseline, a 7B remote model and a
 * local LoRA can produce numbers that mean the same thing (spec §7.1). Anything a
 * specific brain needs to expose — a cache, a spend counter — is handed in as metadata by
 * the caller, never sniffed for here.
 */
import type { BacktestConfig, Decision, Side, Trace } from '../src/types.js';
import type { DecideFn } from '../src/sim/backtest.js';
import { runBacktest } from '../src/sim/backtest.js';
import { WARMUP } from '../src/features/indicators.js';
import {
  SIDES,
  computeMetrics,
  sampleIndices,
  type ConsistencyMetrics,
  type EvalMetrics,
} from './metrics.js';
import { DEFAULT_THRESHOLDS, failed, runChecks, type Check, type Thresholds } from './thresholds.js';
import { BrainContractError, ServiceUnavailableError, isTransportError } from './exit-codes.js';
import type { Holdout } from './holdout.js';

/** What the CLI hands the harness. `decide` is the whole contract; the rest is labelling. */
export interface Brain {
  name: string;
  decide: DecideFn;
  /** Free to run and offline. Only used to decide whether a run needs an explicit opt-in. */
  free: boolean;
  /**
   * The brain memoises responses by input, so repeated identical inputs cannot measure
   * sampling variance. Declared by the caller because only it knows how the brain was
   * constructed.
   */
  cachedResponses: boolean;
}

export interface EvalOptions {
  cfg: BacktestConfig;
  thresholds: Thresholds;
  /** Snapshots re-asked to measure behavioural consistency. */
  consistencyProbes: number;
  /** Answers compared per probed snapshot, including the one from the main pass. */
  consistencyRepeats: number;
  seed: number;
  /** Cap the run for a smoke test or a metered brain. Trims bars, never samples traces. */
  maxDecisions?: number;
  onProgress?: (done: number, total: number) => void;
}

export const DEFAULT_EVAL_OPTIONS: Omit<EvalOptions, 'cfg'> = {
  thresholds: DEFAULT_THRESHOLDS,
  consistencyProbes: 24,
  consistencyRepeats: 3,
  seed: 20260815,
  maxDecisions: undefined,
  onProgress: undefined,
};

export interface EvalRun {
  brain: string;
  metrics: EvalMetrics;
  checks: Check[];
  passed: boolean;
  decisionCalls: number;
  /** Transport errors that were retried successfully. Any at all taints the run. */
  transportRetries: number;
}

/**
 * Both shipped LLM brains signal an unparseable response the same way: a FLAT decision
 * whose rationale starts with this prefix (src/agent/inference.ts, src/agent/adapter.ts).
 * Reading the convention rather than the brain keeps the harness brain-agnostic — a new
 * brain that follows it is measured correctly with no change here.
 */
const UNPARSEABLE_PREFIX = 'unparseable:';

function isParseFailure(d: Decision): boolean {
  return d.rationale.startsWith(UNPARSEABLE_PREFIX);
}

/** Contract violations, as opposed to bad-but-well-formed answers. */
function malformedReason(d: Decision | undefined): string | undefined {
  if (!d || typeof d !== 'object') return 'decision was not an object';
  if (!SIDES.includes(d.action)) return `action ${JSON.stringify(d.action)} is not a Side`;
  if (!Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) {
    return `confidence ${d.confidence} is outside 0..1`;
  }
  if (typeof d.rationale !== 'string') return 'rationale is not a string';
  if (typeof d.model !== 'string' || d.model.length === 0) return 'model is empty';
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One retry is enough to ride out a dropped socket; a second failure is a real outage. */
const RETRIES_PER_CALL = 1;
const RETRY_DELAY_MS = 1_000;

interface Instrumented {
  decide: DecideFn;
  calls: () => number;
  parseFailures: () => number;
  malformed: () => number;
  transportRetries: () => number;
}

/**
 * Wraps a DecideFn so that every way it can misbehave lands in a different bucket.
 *
 * A malformed decision is neutralised to FLAT and counted rather than thrown, mirroring
 * how the LLM brains treat an unparseable response: the run must finish, because a
 * half-finished run produces a biased accuracy that looks like a real number. A transport
 * failure is the opposite — it is not the brain's fault and must never be scored, so it
 * aborts the run instead of being averaged into it.
 */
function instrument(brain: Brain): Instrumented {
  let calls = 0;
  let parseFailures = 0;
  let malformed = 0;
  let transportRetries = 0;

  const decide: DecideFn = async (snapshot) => {
    for (let attempt = 0; ; attempt++) {
      let raw: Decision;
      try {
        raw = await brain.decide(snapshot);
      } catch (err) {
        if (!isTransportError(err)) {
          throw new BrainContractError(
            `${brain.name} threw on a well-formed snapshot at ${new Date(snapshot.at).toISOString()}: ` +
              `${(err as Error).message}`,
          );
        }
        if (attempt >= RETRIES_PER_CALL) {
          throw new ServiceUnavailableError(
            `${brain.name} is unreachable after ${attempt + 1} attempts: ${(err as Error).message}`,
          );
        }
        transportRetries++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      calls++;
      const reason = malformedReason(raw);
      if (reason) {
        malformed++;
        return {
          action: 'FLAT',
          confidence: 0,
          rationale: `malformed: ${reason}`,
          generation: Number.isFinite(raw?.generation) ? raw.generation : -1,
          model: typeof raw?.model === 'string' && raw.model ? raw.model : brain.name,
        };
      }
      if (isParseFailure(raw)) parseFailures++;
      return raw;
    }
  };

  return {
    decide,
    calls: () => calls,
    parseFailures: () => parseFailures,
    malformed: () => malformed,
    transportRetries: () => transportRetries,
  };
}

/**
 * Re-asks a seeded sample of snapshots and checks the answers agree.
 *
 * Identical input, identical output is the weakest possible behavioural guarantee, and
 * both LLM brains are supposed to provide it: they run at temperature 0. When this drops,
 * every cross-generation comparison in the project loses its meaning, because the same
 * model measured twice would rank differently.
 */
async function probeConsistency(
  traces: Trace[],
  decide: DecideFn,
  brain: Brain,
  probes: number,
  repeats: number,
  seed: number,
): Promise<ConsistencyMetrics | null> {
  if (probes <= 0 || repeats <= 1 || traces.length === 0) return null;

  const indices = sampleIndices(traces.length, probes, seed);
  const disagreements: Array<{ at: number; actions: Side[] }> = [];
  let agreed = 0;

  for (const index of indices) {
    const trace = traces[index]!;
    const seen: Side[] = [trace.decision.action];

    for (let r = 1; r < repeats; r++) {
      seen.push((await decide(trace.snapshot)).action);
    }

    if (seen.every((a) => a === seen[0])) agreed++;
    else disagreements.push({ at: trace.snapshot.at, actions: seen });
  }

  return {
    snapshots: indices.length,
    repeats,
    agreementRate: indices.length > 0 ? agreed / indices.length : 0,
    disagreements,
    cacheSuspected: brain.cachedResponses,
  };
}

/** Bars the harness will actually take a decision on, given warm-up and horizon. */
export function decisionCount(bars: number, cfg: BacktestConfig): number {
  const last = bars - cfg.horizon - 1;
  if (last <= WARMUP) return 0;
  return Math.ceil((last - WARMUP + 1) / Math.max(1, cfg.stride));
}

/** Trims from the end, so a capped run is a prefix of the full one rather than a sample. */
function limitCandles<T>(candles: T[], cfg: BacktestConfig, maxDecisions?: number): T[] {
  if (!maxDecisions || maxDecisions <= 0) return candles;
  const needed = WARMUP + maxDecisions * Math.max(1, cfg.stride) + cfg.horizon;
  return candles.slice(0, Math.min(candles.length, needed));
}

export async function evaluate(
  brain: Brain,
  holdout: Holdout,
  options: EvalOptions,
): Promise<EvalRun> {
  const candles = limitCandles(holdout.candles, options.cfg, options.maxDecisions);
  const probe = instrument(brain);

  const traces = await runBacktest(candles, probe.decide, options.cfg, options.onProgress);

  // Counted before the consistency probe re-asks anything: parse-failure rate is a
  // property of one pass over the window, and re-asking two dozen bars would weight them
  // three times in the denominator.
  const parseFailures = probe.parseFailures();
  const malformed = probe.malformed();

  const consistency = await probeConsistency(
    traces,
    probe.decide,
    brain,
    options.consistencyProbes,
    options.consistencyRepeats,
    options.seed,
  );

  const metrics = computeMetrics(traces, {
    parseFailures,
    malformed,
    consistency,
    minActionShare: options.thresholds.minActionShare,
  });

  const checks = runChecks(metrics, options.thresholds);

  return {
    brain: brain.name,
    metrics,
    checks,
    passed: failed(checks).length === 0,
    decisionCalls: probe.calls(),
    transportRetries: probe.transportRetries(),
  };
}
