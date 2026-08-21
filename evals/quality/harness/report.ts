/**
 * Report rendering.
 *
 * Every failed check prints the number, the bar it missed, and the reason the bar exists.
 * A red line with no explanation gets rationalised away by whoever reads it next, which is
 * how a threshold quietly stops being a threshold.
 */
import type { EvalReport } from './types.js';
import { SIDES } from './types.js';

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;

function confusionBlock(report: EvalReport): string[] {
  const lines = ['  confusion (rows = market truth, columns = brain said)', '            LONG   SHORT    FLAT'];
  for (const truth of SIDES) {
    const cells = SIDES.map((said) => String(report.accuracy.confusion[truth][said]).padStart(7));
    lines.push(`    ${truth.padEnd(6)}${cells.join(' ')}`);
  }
  return lines;
}

export function formatReport(report: EvalReport): string {
  const a = report.accuracy;
  const d = report.actions;
  const lines: string[] = [];

  lines.push(`=== ${report.brain}  (${report.model}) ===`);
  lines.push(
    `  window         ${report.window.name} [${report.window.relation} training]  ` +
      `${report.window.symbol} ${report.window.interval}`,
  );
  lines.push(`                 ${report.window.from} -> ${report.window.to}`);
  lines.push(
    `  training data  ${new Date(report.window.trainingStartAt).toISOString()} -> ` +
      `${new Date(report.window.trainingEndAt).toISOString()}`,
  );
  lines.push(`  decisions      ${report.integrity.decisions}`);
  lines.push('');

  lines.push('  -- action distribution --');
  lines.push(
    `  counts         L:${d.counts.LONG} S:${d.counts.SHORT} F:${d.counts.FLAT}   ` +
      `(${d.used}/3 actions used)`,
  );
  lines.push(
    `  shares         L:${pct(d.shares.LONG)} S:${pct(d.shares.SHORT)} F:${pct(d.shares.FLAT)}`,
  );
  lines.push(`  entropy        ${d.entropy.toFixed(3)}  (1.000 = perfectly even)`);
  lines.push('');

  lines.push('  -- decision quality --');
  lines.push(`  accuracy       ${pct(a.accuracy)}`);
  lines.push(`  always-FLAT    ${pct(a.flatAccuracy)}   <- same window, no skill required`);
  lines.push(`  edge           ${signed(a.edgeOverFlat)}`);
  lines.push(`  balanced acc   ${pct(a.balancedAccuracy)}  (mean per-class recall)`);
  lines.push(`  MCC            ${a.mcc.toFixed(4)}  (0 = constant predictor)`);
  for (const side of SIDES) {
    const c = a.perClass[side];
    lines.push(
      `    ${side.padEnd(6)} precision ${pct(c.precision).padStart(7)}  ` +
        `recall ${pct(c.recall).padStart(7)}  f1 ${pct(c.f1).padStart(7)}  n=${c.support}`,
    );
  }
  lines.push(...confusionBlock(report));
  lines.push('');

  lines.push('  -- integrity --');
  lines.push(
    `  parse failures ${report.integrity.parseFailures} ` +
      `(${pct(report.integrity.parseFailureRate)})`,
  );
  lines.push(`  illegal action ${report.integrity.invalidActions}`);
  lines.push(
    `  faults         ${report.integrity.faults}` +
      (report.integrity.firstFault ? `  first: ${report.integrity.firstFault}` : ''),
  );

  if (report.consistency) {
    const c = report.consistency;
    lines.push(
      `  consistency    ${pct(c.consistency)}  ` +
        `(${c.unanimous}/${c.probes} probes unanimous over ${c.repeats} repeats)`,
    );
    lines.push(`  modal agree    ${pct(c.modalAgreement)}`);
    for (const flip of c.flips) {
      lines.push(`    flip @ ${new Date(flip.at).toISOString()}: ${flip.answers.join(' ')}`);
    }
  } else {
    lines.push('  consistency    skipped (--no-consistency)');
  }
  lines.push('');

  lines.push('  -- economics (reported, never gated) --');
  lines.push(`  mean return    ${pct(report.economics.meanReturn)} per decision`);
  lines.push(`  cumulative     ${pct(report.economics.cumulativeReturn)}`);
  lines.push(`  sharpe         ${report.economics.sharpe.toFixed(2)}`);
  lines.push(`  max drawdown   ${pct(report.economics.maxDrawdown)}`);
  lines.push('');

  lines.push(`  -- checks (thresholds: ${report.thresholdsSource}) --`);
  for (const c of report.checks) {
    const mark = c.passed ? 'PASS' : 'FAIL';
    lines.push(
      `  [${mark}] ${c.label.padEnd(28)} ${c.value.toFixed(4)} ${c.comparator} ` +
        `${c.threshold.toFixed(4)}`,
    );
    if (!c.passed) lines.push(`         why it matters: ${c.why}`);
  }
  lines.push('');
  lines.push(`  VERDICT: ${report.verdict}`);

  return lines.join('\n');
}

/** One line per brain, for the multi-brain summary. */
export function formatSummary(reports: EvalReport[]): string {
  const header =
    '  brain            verdict  decisions  accuracy  vs-flat      MCC  minShare  parse  consist';
  const rows = reports.map((r) => {
    const consistency = r.consistency ? pct(r.consistency.consistency) : 'n/a';
    return [
      `  ${r.brain.padEnd(16)}`,
      r.verdict.padEnd(7),
      String(r.integrity.decisions).padStart(9),
      pct(r.accuracy.accuracy).padStart(9),
      signed(r.accuracy.edgeOverFlat).padStart(8),
      r.accuracy.mcc.toFixed(3).padStart(8),
      pct(r.actions.minShare).padStart(9),
      pct(r.integrity.parseFailureRate).padStart(6),
      consistency.padStart(8),
    ].join(' ');
  });
  return [header, ...rows].join('\n');
}

/** Which check killed a run, in one line — the part CI logs actually get read for. */
export function failureSummary(report: EvalReport): string {
  const failed = report.checks.filter((c) => !c.passed);
  if (failed.length === 0) return `${report.brain}: all checks passed`;
  return `${report.brain}: failed ${failed.map((c) => c.id).join(', ')}`;
}
