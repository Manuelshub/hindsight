/**
 * The eval runner.
 *
 * Scoring goes through `scoreDecision` and `computeStats` from `src/sim/backtest.ts`
 * rather than through a copy — an eval that grades on its own reimplementation of the
 * rules can pass while production is broken, which is the one way an eval suite can be
 * actively harmful.
 *
 * The bar loop is local rather than `runBacktest` because this suite has to skip every
 * bar the holdout boundary excludes and has to tell a thrown call apart from a bad
 * answer. `runBacktest` does neither, and correctly so: it is a production harness, and a
 * production run that starts throwing should stop, not annotate.
 */
import type { BacktestConfig, DecideFn, Decision, Side, Trace } from './project.js';
import { buildSnapshot, computeStats, scoreDecision } from './project.js';
import { probeConsistency } from './consistency.js';
import { accuracyMetrics, actionDistribution, isParseFailure, isSide } from './metrics.js';
import type {
  CheckResult,
  ConsistencyMetrics,
  EvalReport,
  Holdout,
  IntegrityMetrics,
  Thresholds,
} from './types.js';

/**
 * The brain stopped answering.
 *
 * Kept distinct from every quality signal all the way to the exit code. "Your agent is
 * bad" is a result you publish; "the adapter server died" is an outage you retry. A suite
 * that reports them with the same failure teaches its operators to ignore both.
 */
export class ServiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause_: unknown,
  ) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/** Too few usable decisions to say anything. Not the brain's fault, not a verdict. */
export class InsufficientDecisionsError extends Error {
  constructor(
    readonly got: number,
    readonly need: number,
  ) {
    super(`scored ${got} decisions but ${need} are needed for a verdict`);
    this.name = 'InsufficientDecisionsError';
  }
}

export interface RunOptions {
  brain: string;
  decide: DecideFn;
  holdout: Holdout;
  cfg: BacktestConfig;
  thresholds: Thresholds;
  thresholdsSource: string;
  seed: number;
  probes: number;
  repeats: number;
  runConsistency: boolean;
  /** Cap on scored decisions, so a paid brain can be sampled instead of run in full. */
  maxDecisions?: number;
  /** Consecutive throws that end the run as an outage. */
  faultLimit: number;
  onProgress?: (done: number, total: number) => void;
}

function check(
  id: string,
  label: string,
  value: number,
  comparator: '>=' | '<=',
  threshold: number,
  why: string,
): CheckResult {
  return {
    id,
    label,
    value,
    threshold,
    comparator,
    passed: comparator === '>=' ? value >= threshold : value <= threshold,
    why,
  };
}

/**
 * Selects the bars to score, thinning evenly when capped.
 *
 * Evenly rather than by truncation: taking the first N bars of a window would grade a
 * paid brain on one market regime and call it the whole period.
 */
function selectIndices(scoreable: number[], stride: number, max?: number): number[] {
  const strided = scoreable.filter((_, k) => k % Math.max(1, stride) === 0);
  if (max === undefined || strided.length <= max) return strided;
  if (max <= 1) return strided.slice(0, max);

  // Both endpoints included, so a capped run still spans the window edge to edge and its
  // reported date range is the same one the uncapped run would have printed.
  const step = (strided.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => strided[Math.round(k * step)]!);
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
  const { holdout, cfg, thresholds } = options;
  const indices = selectIndices(holdout.scoreable, cfg.stride, options.maxDecisions);

  if (indices.length === 0) throw new InsufficientDecisionsError(0, thresholds.minDecisions);

  // One call before committing to the window. A brain that is simply down should cost a
  // second and a clear message, not the full run's wall time followed by a vague one.
  const first = buildSnapshot(holdout.candles, indices[0]!, cfg.symbol, cfg.interval);
  try {
    await options.decide(first);
  } catch (err) {
    throw new ServiceUnavailableError(
      `${options.brain} failed on its first decision: ${(err as Error).message}`,
      err,
    );
  }

  const traces: Trace[] = [];
  const actions: Side[] = [];
  const scored: number[] = [];
  const integrity: IntegrityMetrics = {
    decisions: 0,
    parseFailures: 0,
    parseFailureRate: 0,
    invalidActions: 0,
    faults: 0,
    firstFault: null,
  };
  let consecutiveFaults = 0;
  let model = 'unknown';

  for (const i of indices) {
    const snapshot = buildSnapshot(holdout.candles, i, cfg.symbol, cfg.interval);

    let decision: Decision;
    try {
      decision = await options.decide(snapshot);
      consecutiveFaults = 0;
    } catch (err) {
      integrity.faults++;
      integrity.firstFault ??= (err as Error).message;
      if (++consecutiveFaults >= options.faultLimit) {
        throw new ServiceUnavailableError(
          `${options.brain} threw on ${consecutiveFaults} consecutive decisions ` +
            `(${integrity.faults} total): ${integrity.firstFault}`,
          err,
        );
      }
      continue;
    }

    model = decision.model;
    integrity.decisions++;
    if (isParseFailure(decision)) integrity.parseFailures++;

    // An action outside the three legal sides is a broken brain, not a bearish one. It is
    // recorded and then scored as FLAT so one malformed reply cannot abort the window.
    const action: Side = isSide(decision.action) ? decision.action : 'FLAT';
    if (!isSide(decision.action)) integrity.invalidActions++;

    const outcome = scoreDecision(holdout.candles, i, action, cfg);
    traces.push({
      id: `${cfg.symbol}-${cfg.interval}-${snapshot.at}-eval`,
      snapshot,
      decision: { ...decision, action },
      outcome,
    });
    actions.push(action);
    scored.push(i);
    options.onProgress?.(traces.length, indices.length);
  }

  integrity.parseFailureRate =
    integrity.decisions > 0 ? integrity.parseFailures / integrity.decisions : 0;

  if (traces.length < thresholds.minDecisions) {
    throw new InsufficientDecisionsError(traces.length, thresholds.minDecisions);
  }

  let consistency: ConsistencyMetrics | null = null;
  if (options.runConsistency && options.probes > 0 && options.repeats > 0) {
    try {
      consistency = await probeConsistency(options.decide, {
        candles: holdout.candles,
        cfg,
        scored,
        answers: actions,
        probes: options.probes,
        repeats: options.repeats,
        seed: options.seed,
        faultLimit: options.faultLimit,
      });
    } catch (err) {
      throw new ServiceUnavailableError(
        `${options.brain} failed during the consistency probe: ${(err as Error).message}`,
        err,
      );
    }
  }

  const distribution = actionDistribution(actions);
  const accuracy = accuracyMetrics(
    actions,
    traces.map((t) => t.outcome),
  );
  const stats = computeStats(traces, cfg);

  const checks: CheckResult[] = [
    check(
      'coverage',
      'least-used action share',
      distribution.minShare,
      '>=',
      thresholds.minActionShare,
      'a brain that never emits one of LONG/SHORT/FLAT has lost a third of its action ' +
        'space; both live generations have never once emitted FLAT',
    ),
    check(
      'edge',
      'accuracy over always-FLAT',
      accuracy.edgeOverFlat,
      '>=',
      thresholds.minEdgeOverFlat,
      'doing nothing is the hardest baseline on this data; below it the brain has ' +
        'negative information value',
    ),
    check(
      'parse',
      'parse-failure rate',
      integrity.parseFailureRate,
      '<=',
      thresholds.maxParseFailureRate,
      'unreadable answers are scored as FLAT, so a high rate means the accuracy figure ' +
        'is measuring the parser rather than the brain',
    ),
    check(
      'skill',
      'Matthews correlation',
      accuracy.mcc,
      '>=',
      thresholds.minMcc,
      'exactly 0 for any constant predictor, so it separates real signal from a brain ' +
        'that has only learned the class prior',
    ),
  ];

  if (consistency) {
    checks.push(
      check(
        'consistency',
        'identical-input agreement',
        consistency.consistency,
        '>=',
        thresholds.minConsistency,
        'if repeated runs move more than the gap between generations, the improvement ' +
          'claim is measuring noise',
      ),
    );
  }

  return {
    brain: options.brain,
    model,
    window: {
      name: holdout.name,
      relation: holdout.relation,
      symbol: cfg.symbol,
      interval: cfg.interval,
      from: new Date(holdout.candles[scored[0]!]!.closeTime).toISOString(),
      to: new Date(holdout.candles[scored.at(-1)!]!.closeTime).toISOString(),
      trainingStartAt: holdout.manifest.training.startAt,
      trainingEndAt: holdout.manifest.training.endAt,
    },
    seed: options.seed,
    thresholdsSource: options.thresholdsSource,
    thresholds,
    actions: distribution,
    accuracy,
    integrity,
    consistency,
    economics: {
      meanReturn: stats.meanReturn,
      cumulativeReturn: stats.cumulativeReturn,
      sharpe: stats.sharpe,
      maxDrawdown: stats.maxDrawdown,
    },
    checks,
    verdict: checks.every((c) => c.passed) ? 'PASS' : 'FAIL',
  };
}
