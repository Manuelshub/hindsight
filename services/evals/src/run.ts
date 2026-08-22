/**
 * The eval runner.
 *
 * Scoring goes through `scoreDecision` and `computeStats` from
 * `services/scoring/src/backtest.ts` rather than through a copy — an eval that grades on
 * its own reimplementation of the rules can pass while production is broken, which is the
 * one way an eval suite can be actively harmful.
 *
 * The bar loop is local rather than `runBacktest` because this suite has to skip every bar
 * the holdout boundary excludes, has to tell a thrown call apart from a bad answer, and
 * has to survive a `DecideFn` that returns something which is not a `Decision` at all.
 * `runBacktest` does none of those, and correctly so: it is a production harness, and a
 * production run that starts throwing should stop, not annotate.
 */
import type { BacktestConfig, Decision, DecideFn, Side, Trace } from './project.js';
import { buildSnapshot, computeStats, scoreDecision } from './project.js';
import { probeConsistency } from './consistency.js';
import {
  accuracyMetrics,
  actionDistribution,
  isParseFailure,
  malformedReason,
  neutralise,
} from './metrics.js';
import type {
  AccuracyMetrics,
  CheckResult,
  ConsistencyMetrics,
  EvalReport,
  Holdout,
  Severity,
  Thresholds,
  Verdict,
} from './types.js';
import { SIDES } from './types.js';

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
  thresholdsRelaxed: boolean;
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

interface CheckSpec {
  id: string;
  label: string;
  value: number;
  comparator: '>=' | '<=';
  threshold: number;
  why: string;
  /**
   * True when a *failure* of this check could be an artifact of how few bars the window
   * holds, rather than a property of the brain. Those are demoted to warnings on an
   * underpowered window.
   *
   * Almost nothing qualifies, on purpose. Statistical power is required to certify a brain,
   * not to withhold certification: a FAIL is the claim "this was not demonstrated", which
   * is safe at any sample size, while a PASS is a positive claim and is what the power
   * floor restrains. See `coverage` for the one documented exception.
   */
  needsPower: boolean;
}

function check(spec: CheckSpec, powered: boolean, demotion?: string): CheckResult {
  const passed =
    spec.comparator === '>=' ? spec.value >= spec.threshold : spec.value <= spec.threshold;

  let severity: Severity = 'fail';
  let demotedBecause: string | undefined;
  if (demotion) {
    severity = 'warn';
    demotedBecause = demotion;
  } else if (spec.needsPower && !powered) {
    severity = 'warn';
    demotedBecause = 'window is underpowered';
  }

  return {
    id: spec.id,
    label: spec.label,
    value: spec.value,
    threshold: spec.threshold,
    comparator: spec.comparator,
    passed,
    severity,
    ...(demotedBecause === undefined ? {} : { demotedBecause }),
    why: spec.why,
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

/**
 * The reason a coverage failure is the market's fault rather than the brain's.
 *
 * The gate exists to catch a brain that has lost an action — both live generations have
 * never once emitted FLAT. It is not meant to catch a brain that declined to bet on a move
 * the market only made three times. When the action the brain under-used is one the market
 * itself paid out below the same threshold, the number is measuring the regime, so the
 * check reports and stops deciding.
 */
function marketScarcity(
  minActionShare: number,
  brainShares: Record<Side, number>,
  marketShares: Record<Side, number>,
): string | undefined {
  const scarce = SIDES.filter(
    (s) => brainShares[s] < minActionShare && marketShares[s] < minActionShare,
  );
  if (scarce.length === 0) return undefined;
  const detail = scarce
    .map((s) => `${s} was correct on only ${(marketShares[s] * 100).toFixed(2)}% of bars`)
    .join('; ');
  return `market scarcity — ${detail}`;
}

function buildChecks(
  thresholds: Thresholds,
  powered: boolean,
  accuracy: AccuracyMetrics,
  distribution: ReturnType<typeof actionDistribution>,
  integrity: EvalReport['integrity'],
  economics: EvalReport['economics'],
  consistency: ConsistencyMetrics | null,
): CheckResult[] {
  const checks: CheckResult[] = [
    check(
      {
        id: 'coverage',
        label: 'least-used action share',
        value: distribution.minShare,
        comparator: '>=',
        threshold: thresholds.minActionShare,
        // An action emitted zero times is a lost action and stays a hard failure on any
        // window — that is gen-0 and gen-1's exact defect, 736 decisions with no FLAT at
        // all. An action emitted twice where the bar wanted three is a small sample, and
        // on 140 bars a genuinely skilled brain lands there routinely. Only the second
        // case is demoted.
        needsPower: distribution.used === 3,
        why:
          'a brain that never emits one of LONG/SHORT/FLAT has lost a third of its action ' +
          'space; both live generations have never once emitted FLAT',
      },
      powered,
      marketScarcity(thresholds.minActionShare, distribution.shares, accuracy.marketShares),
    ),
    check(
      {
        id: 'edge',
        label: 'accuracy over always-FLAT',
        value: accuracy.edgeOverFlat,
        comparator: '>=',
        threshold: thresholds.minEdgeOverFlat,
        needsPower: false,
        why:
          'doing nothing is the hardest baseline on this data; below it the brain has ' +
          'negative information value',
      },
      powered,
    ),
    check(
      {
        id: 'significance',
        label: 'McNemar p vs always-FLAT',
        value: accuracy.edgePValue,
        comparator: '<=',
        threshold: thresholds.maxEdgePValue,
        needsPower: false,
        why:
          'a positive edge this test cannot separate from noise is not evidence of skill; ' +
          'the 2.17pp gap between generations 0 and 1 is exactly this size',
      },
      powered,
      // Always a warning. A genuinely skilled brain can miss significance on a short
      // window, and failing it there would punish the fixture rather than the brain. It is
      // the power floor, not this check, that stops a noisy edge being certified.
      'advisory by design',
    ),
    check(
      {
        id: 'economics',
        label: 'mean return per decision',
        value: economics.meanReturn,
        comparator: '>=',
        threshold: thresholds.minMeanReturn,
        needsPower: false,
        why:
          'accuracy and money come apart here: mean-reversion clears the accuracy bar by ' +
          '+0.21pp while losing 70% cumulative, because every non-FLAT bar pays costPerTrade',
      },
      powered,
    ),
    check(
      {
        id: 'parse',
        label: 'parse-failure rate',
        value: integrity.parseFailureRate,
        comparator: '<=',
        threshold: thresholds.maxParseFailureRate,
        needsPower: false,
        why:
          'unreadable answers are scored as FLAT, so a high rate means the accuracy figure ' +
          'is measuring the parser rather than the brain',
      },
      powered,
    ),
    check(
      {
        id: 'contract',
        label: 'malformed-decision rate',
        value: integrity.malformedRate,
        comparator: '<=',
        threshold: thresholds.maxMalformedRate,
        needsPower: false,
        why:
          'a return that is not a Decision — null, an action outside Side, a confidence ' +
          'outside 0..1 — is a broken integration, and averaging one into a hit rate ' +
          'produces a number about nothing',
      },
      powered,
    ),
    check(
      {
        id: 'faults',
        label: 'thrown-call rate',
        value: integrity.faultRate,
        comparator: '<=',
        threshold: thresholds.maxFaultRate,
        needsPower: false,
        why:
          'dropped calls are not a neutral sample — they cluster on the hard prompts and ' +
          'the rate-limited stretches, so past this rate every metric above is computed on ' +
          'a biased subsample and the verdict is withdrawn rather than reported',
      },
      powered,
    ),
    check(
      {
        id: 'skill',
        label: 'Matthews correlation',
        value: accuracy.mcc,
        comparator: '>=',
        threshold: thresholds.minMcc,
        needsPower: false,
        why:
          'exactly 0 for any constant predictor, so it separates real signal from a brain ' +
          'that has only learned the class prior',
      },
      powered,
    ),
  ];

  if (consistency) {
    checks.push(
      check(
        {
          id: 'consistency',
          label: 'identical-input agreement',
          value: consistency.consistency,
          comparator: '>=',
          threshold: thresholds.minConsistency,
          needsPower: false,
          why:
            'if repeated runs move more than the gap between generations, the improvement ' +
            'claim is measuring noise',
        },
        powered,
      ),
    );
  }

  return checks;
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
  const { holdout, cfg, thresholds } = options;
  const indices = selectIndices(holdout.scoreable, cfg.stride, options.maxDecisions);

  if (indices.length === 0) throw new InsufficientDecisionsError(0, thresholds.minDecisions);

  const traces: Trace[] = [];
  const actions: Side[] = [];
  const scored: number[] = [];
  const integrity: EvalReport['integrity'] = {
    decisions: 0,
    attempts: 0,
    parseFailures: 0,
    parseFailureRate: 0,
    malformed: 0,
    malformedRate: 0,
    firstMalformed: null,
    faults: 0,
    faultRate: 0,
    firstFault: null,
  };
  let consecutiveFaults = 0;
  let model = 'unknown';

  for (const i of indices) {
    const snapshot = buildSnapshot(holdout.candles, i, cfg.symbol, cfg.interval);

    // Deliberately `unknown`: the value has crossed a `DecideFn` boundary, and the whole
    // reason this loop exists is that TypeScript's word for what came back is not evidence.
    let returned: unknown;
    integrity.attempts++;
    try {
      returned = await options.decide(snapshot);
      consecutiveFaults = 0;
    } catch (err) {
      // Failing on the very first call is reachability, not quality: nothing has been
      // measured yet, so the run stops with a clear message in a second rather than after
      // the full window's wall time. Later throws are tolerated and counted, because one
      // dropped call from a live service is a hiccup, not an outage.
      if (integrity.attempts === 1) {
        throw new ServiceUnavailableError(
          `${options.brain} failed on its first decision: ${(err as Error).message}`,
          err,
        );
      }
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

    // A contract violation is a bug in the brain, and a bug in the brain must never reach
    // the top-level handler and be reported as bad usage. It is neutralised to FLAT so one
    // bad reply cannot abort the window, counted, and gated by the `contract` check.
    const reason = malformedReason(returned);
    let decision: Decision;
    if (reason === undefined) {
      decision = returned as Decision;
    } else {
      decision = neutralise(returned, reason);
      integrity.malformed++;
      integrity.firstMalformed ??= `${new Date(snapshot.at).toISOString()}: ${reason}`;
    }

    model = decision.model;
    integrity.decisions++;
    if (isParseFailure(decision)) integrity.parseFailures++;

    const outcome = scoreDecision(holdout.candles, i, decision.action, cfg);
    traces.push({
      id: `${cfg.symbol}-${cfg.interval}-${snapshot.at}-eval`,
      snapshot,
      decision,
      outcome,
    });
    actions.push(decision.action);
    scored.push(i);
    options.onProgress?.(traces.length, indices.length);
  }

  integrity.parseFailureRate =
    integrity.decisions > 0 ? integrity.parseFailures / integrity.decisions : 0;
  integrity.malformedRate =
    integrity.decisions > 0 ? integrity.malformed / integrity.decisions : 0;
  integrity.faultRate = integrity.attempts > 0 ? integrity.faults / integrity.attempts : 0;

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
  const economics = {
    meanReturn: stats.meanReturn,
    cumulativeReturn: stats.cumulativeReturn,
    sharpe: stats.sharpe,
    maxDrawdown: stats.maxDrawdown,
  };

  const powered = traces.length >= thresholds.minPoweredDecisions;
  const checks = buildChecks(
    thresholds,
    powered,
    accuracy,
    distribution,
    integrity,
    economics,
    consistency,
  );

  // A hard failure outranks the power floor: a brain that returned 30% malformed decisions
  // is broken on any sample size, and integrity checks do not need statistical power to be
  // read. What the floor forbids is the other direction — certifying a pass on a window
  // whose own noise is larger than the effect being claimed.
  const hardFailure = checks.some((c) => c.severity === 'fail' && !c.passed);
  const verdict: Verdict = hardFailure ? 'FAIL' : powered ? 'PASS' : 'INCONCLUSIVE';

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
      powered,
    },
    seed: options.seed,
    thresholdsSource: options.thresholdsSource,
    thresholdsRelaxed: options.thresholdsRelaxed,
    thresholds,
    actions: distribution,
    accuracy,
    integrity,
    consistency,
    economics,
    checks,
    verdict,
  };
}
