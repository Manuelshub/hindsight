/**
 * The bar. Frozen values plus the checks that read them.
 *
 * Written down in one place so that "did generation N improve" is answered by a diff of
 * numbers rather than by a diff of opinions. Loosening any value here is a deliberate,
 * reviewable act; it is not something a run can do to itself.
 */
import type { EvalMetrics } from './metrics.js';

export interface Thresholds {
  /** An action counts as used only above this share; one token LONG in 2000 bars is noise. */
  minActionShare: number;
  /** How many of LONG/SHORT/FLAT must clear that share. */
  minActionsUsed: number;
  /** A brain that plays one action almost always has not learned a policy, it has a bias. */
  maxActionShare: number;
  /** Accuracy minus always-FLAT on the same bars. Zero means "must not be worse than doing nothing". */
  minAccuracyEdge: number;
  /** Above this, a positive edge is not distinguishable from noise. Warning, not a failure. */
  maxEdgePValue: number;
  /** Responses that could not be parsed into an action. */
  maxParseFailureRate: number;
  /** Decisions that violated the Decision contract outright. */
  maxMalformedRate: number;
  /** Fraction of repeated identical inputs that must produce identical actions. */
  minSelfAgreement: number;
}

/**
 * The default profile.
 *
 * `minAccuracyEdge: 0` is the project's own stated bar ("46.33% is the number to beat"):
 * a generation that cannot match doing nothing has learned nothing, and the eval says so
 * rather than reporting a rank among things that all lose money.
 *
 * `minSelfAgreement: 0.95` rather than 1.0 leaves room for genuine sampling temperature
 * without leaving room for a brain that answers a coin flip.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minActionShare: 0.02,
  minActionsUsed: 3,
  maxActionShare: 0.9,
  minAccuracyEdge: 0,
  maxEdgePValue: 0.05,
  maxParseFailureRate: 0.02,
  maxMalformedRate: 0,
  minSelfAgreement: 0.95,
};

export type Severity = 'fail' | 'warn';

export interface Check {
  id: string;
  /** What the number would mean if it went the wrong way. */
  question: string;
  severity: Severity;
  passed: boolean;
  observed: string;
  required: string;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

export function runChecks(m: EvalMetrics, t: Thresholds): Check[] {
  const checks: Check[] = [
    {
      id: 'action-coverage',
      question: 'does the brain have all three actions available to it in practice?',
      severity: 'fail',
      passed: m.actionsUsed >= t.minActionsUsed,
      observed: `${m.actionsUsed}/3 used${m.unusedActions.length ? ` (missing ${m.unusedActions.join(',')})` : ''}`,
      required: `>= ${t.minActionsUsed} at >= ${fmtPct(t.minActionShare)} share`,
    },
    {
      id: 'action-concentration',
      question: 'is it a policy, or one action with rounding error?',
      severity: 'fail',
      passed: m.maxActionShare <= t.maxActionShare,
      observed: fmtPct(m.maxActionShare),
      required: `<= ${fmtPct(t.maxActionShare)}`,
    },
    {
      id: 'beats-flat',
      question: 'is it better than refusing to trade?',
      severity: 'fail',
      passed: m.accuracyEdge >= t.minAccuracyEdge,
      observed: `${fmtPct(m.accuracy)} vs ${fmtPct(m.flatBaselineAccuracy)} (edge ${fmtPct(m.accuracyEdge)})`,
      required: `edge >= ${fmtPct(t.minAccuracyEdge)}`,
    },
    {
      id: 'edge-significance',
      question: 'is that edge bigger than the noise in this window?',
      severity: 'warn',
      passed: m.edgePValue <= t.maxEdgePValue,
      observed: `p = ${m.edgePValue.toExponential(2)}`,
      required: `p <= ${t.maxEdgePValue}`,
    },
    {
      id: 'parse-failures',
      question: 'did the brain answer the question that was asked?',
      severity: 'fail',
      passed: m.parseFailureRate <= t.maxParseFailureRate,
      observed: fmtPct(m.parseFailureRate),
      required: `<= ${fmtPct(t.maxParseFailureRate)}`,
    },
    {
      id: 'malformed-decisions',
      question: 'did every decision satisfy the Decision contract?',
      severity: 'fail',
      passed: m.malformedRate <= t.maxMalformedRate,
      observed: fmtPct(m.malformedRate),
      required: `<= ${fmtPct(t.maxMalformedRate)}`,
    },
  ];

  if (m.consistency) {
    checks.push({
      id: 'self-consistency',
      question: 'does the same input get the same answer?',
      severity: 'fail',
      passed: m.consistency.agreementRate >= t.minSelfAgreement,
      observed: `${fmtPct(m.consistency.agreementRate)} over ${m.consistency.snapshots} x ${m.consistency.repeats}`,
      required: `>= ${fmtPct(t.minSelfAgreement)}`,
    });
  }

  return checks;
}

/** Warnings are printed and recorded but never decide the exit code. */
export function failed(checks: Check[]): Check[] {
  return checks.filter((c) => !c.passed && c.severity === 'fail');
}
