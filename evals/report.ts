/**
 * Rendering. Text for a human at a terminal, JSON for a diff between generations.
 *
 * The layout deliberately puts the market's own action distribution next to the brain's.
 * Accuracy alone hid the single largest finding this project has produced so far — that
 * neither generation had ever emitted FLAT, in a window where FLAT was the right answer
 * roughly half the time — and a number that can hide that is not a report.
 */
import type { Side } from '../src/types.js';
import { SIDES, type EvalMetrics } from './metrics.js';
import type { Check } from './thresholds.js';
import type { EvalRun } from './harness.js';
import type { IntegrityReport } from './holdout.js';
import { iso } from './holdout.js';
import type { Thresholds } from './thresholds.js';

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function bar(share: number, width = 20): string {
  const filled = Math.round(share * width);
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

export function formatIntegrity(report: IntegrityReport, symbol: string, interval: string): string {
  const lines = [
    'held-out window',
    `  ${symbol} ${interval}  ${report.bars} bars  ${iso(report.windowFrom)} -> ${iso(report.windowTo)}`,
    `  proven disjoint from ${report.checkedAgainst.length} window(s) the agent may have seen:`,
  ];
  for (const w of report.checkedAgainst) {
    lines.push(`    ${iso(w.from)} -> ${iso(w.to)}  ${w.label}`);
  }
  return lines.join('\n');
}

function formatDistribution(m: EvalMetrics): string {
  const lines = ['  action distribution        brain            market truth'];
  for (const side of SIDES) {
    const brainShare = m.actionShares[side];
    const truthShare = m.decisions > 0 ? m.hindsightCounts[side] / m.decisions : 0;
    lines.push(
      `    ${side.padEnd(6)} ${bar(brainShare)} ${pct(brainShare).padStart(7)}   ` +
        `${bar(truthShare)} ${pct(truthShare).padStart(7)}`,
    );
  }
  return lines.join('\n');
}

function formatPerClass(m: EvalMetrics): string {
  const lines = ['  per action        support  chosen  precision  recall      f1'];
  for (const side of SIDES) {
    const c = m.perClass[side];
    lines.push(
      `    ${side.padEnd(14)}${String(c.support).padStart(7)}${String(c.predicted).padStart(8)}` +
        `${pct(c.precision).padStart(11)}${pct(c.recall).padStart(8)}${c.f1.toFixed(3).padStart(8)}`,
    );
  }
  return lines.join('\n');
}

function formatConfusion(m: EvalMetrics): string {
  const lines = ['  confusion (rows = chosen, cols = correct answer)', '                 LONG   SHORT    FLAT'];
  for (const chosen of SIDES) {
    const row = m.confusion[chosen];
    lines.push(
      `    ${chosen.padEnd(8)}` + SIDES.map((s: Side) => String(row[s]).padStart(8)).join(''),
    );
  }
  return lines.join('\n');
}

function formatChecks(checks: Check[]): string {
  const lines = ['  checks'];
  for (const c of checks) {
    const verdict = c.passed ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`    [${verdict}] ${c.id.padEnd(21)} ${c.observed}`);
    if (!c.passed) lines.push(`           required ${c.required} — ${c.question}`);
  }
  return lines.join('\n');
}

export function formatRun(run: EvalRun): string {
  const m = run.metrics;
  const lines = [
    `brain: ${run.brain}`,
    `  decisions      ${m.decisions}  (${run.decisionCalls} calls)`,
    `  accuracy       ${pct(m.accuracy)}`,
    `  always-flat    ${pct(m.flatBaselineAccuracy)}  on these exact bars`,
    `  edge           ${pct(m.accuracyEdge)}  (McNemar p = ${m.edgePValue.toExponential(2)})`,
    `  best constant  ${pct(m.bestConstantAccuracy)}  (always ${m.bestConstantAction})`,
    `  dist distance  ${m.distributionDistance.toFixed(3)}  0 = plays each action as often as it pays`,
    `  mean return    ${pct(m.meanReturn)} per decision`,
    `  cumulative     ${pct(m.cumulativeReturn)}`,
    `  parse failures ${pct(m.parseFailureRate)}`,
    `  malformed      ${pct(m.malformedRate)}`,
    '',
    formatDistribution(m),
    '',
    formatPerClass(m),
    '',
    formatConfusion(m),
    '',
  ];

  if (m.consistency) {
    const c = m.consistency;
    lines.push(
      `  consistency    ${pct(c.agreementRate)} agreement over ${c.snapshots} snapshots x ${c.repeats} asks`,
    );
    if (c.cacheSuspected) {
      lines.push(
        '                 NOTE: this brain answers repeats from its response cache, so the',
        '                 figure describes the cache, not the model. Re-run with --no-cache',
        '                 to measure sampling variance.',
      );
    }
    for (const d of c.disagreements.slice(0, 5)) {
      lines.push(`                 ${iso(d.at)} -> ${d.actions.join(' / ')}`);
    }
    lines.push('');
  }

  if (run.transportRetries > 0) {
    lines.push(
      `  WARNING: ${run.transportRetries} transport error(s) were retried during this run.`,
      '           The numbers above came from a run that had to be nursed along.',
      '',
    );
  }

  lines.push(formatChecks(run.checks));
  lines.push('');
  lines.push(`  verdict: ${run.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

export function formatSummary(runs: EvalRun[]): string {
  const header =
    '  brain              decisions  accuracy  flat-base     edge  actions  parse-fail  verdict';
  const rows = runs.map((r) => {
    const m = r.metrics;
    return [
      `  ${r.brain.slice(0, 17).padEnd(17)}`,
      String(m.decisions).padStart(10),
      pct(m.accuracy).padStart(9),
      pct(m.flatBaselineAccuracy).padStart(10),
      pct(m.accuracyEdge).padStart(8),
      `${m.actionsUsed}/3`.padStart(8),
      pct(m.parseFailureRate).padStart(11),
      (r.passed ? 'PASS' : 'FAIL').padStart(8),
    ].join(' ');
  });
  return [header, ...rows].join('\n');
}

export interface JsonReport {
  suite: 'hindsight-decision-quality';
  schemaVersion: 1;
  generatedAt: string;
  seed: number;
  thresholds: Thresholds;
  holdout: {
    symbol: string;
    interval: string;
    bars: number;
    from: string;
    to: string;
    checkedAgainst: Array<{ label: string; from: string; to: string }>;
  };
  runs: EvalRun[];
  passed: boolean;
}

export function toJson(
  runs: EvalRun[],
  integrity: IntegrityReport,
  symbol: string,
  interval: string,
  thresholds: Thresholds,
  seed: number,
): JsonReport {
  return {
    suite: 'hindsight-decision-quality',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed,
    thresholds,
    holdout: {
      symbol,
      interval,
      bars: integrity.bars,
      from: new Date(integrity.windowFrom).toISOString(),
      to: new Date(integrity.windowTo).toISOString(),
      checkedAgainst: integrity.checkedAgainst.map((w) => ({
        label: w.label,
        from: new Date(w.from).toISOString(),
        to: new Date(w.to).toISOString(),
      })),
    },
    runs,
    passed: runs.every((r) => r.passed),
  };
}
