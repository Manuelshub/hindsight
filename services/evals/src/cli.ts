/**
 * Decision-quality eval suite — entry point.
 *
 *   pnpm eval                                   # every free brain, held-out window
 *   pnpm eval --window pre                      # the large, powered diagnostic window
 *   pnpm eval --brain adapter                   # the local LoRA, generation 1
 *   pnpm eval --brain remote --yes-spend --max-decisions 150
 *
 * Exit codes are the interface. 0 pass, 1 the brain is bad, 2 bad usage, 3 the service is
 * down, 4 the held-out window cannot be trusted, 5 nothing failed but the window is too
 * small to certify a pass. See `types.ts`.
 *
 * Two rules run through the whole file. Nothing the brain returns may ever produce a usage
 * exit code — a bug in a `DecideFn` is a result, not an operator error. And nothing the
 * command line does may ever be silently ignored: an unrecognised flag or an unparseable
 * number stops the run, because a measurement tool that quietly measures something else is
 * worse than one that refuses.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  DEFAULT_BACKTEST,
  MEASURED_INPUT_PRICE_OG,
  MEASURED_OUTPUT_PRICE_OG,
} from './project.js';
import { BRAINS, brainNames, freeBrainNames } from './brains.js';
import { HoldoutError, loadHoldout } from './holdout.js';
import { failureSummary, formatReport, formatSummary } from './report.js';
import { InsufficientDecisionsError, ServiceUnavailableError, runEval } from './run.js';
import { loadThresholds } from './thresholds.js';
import { EXIT } from './types.js';
import type { EvalReport, ExitCode } from './types.js';

/** Rough per-decision spend for a paid brain, from the measured gen-0 token counts. */
const PAID_TOKENS = { input: 330, output: 20 };

/** Flags that consume the next argv entry. Their value is exempt from the unknown check. */
const VALUE_FLAGS = [
  '--brain',
  '--window',
  '--symbol',
  '--interval',
  '--stride',
  '--max-decisions',
  '--probes',
  '--repeats',
  '--seed',
  '--fault-limit',
  '--endpoint',
  '--generation',
  '--thresholds',
  '--json',
] as const;

const BOOLEAN_FLAGS = [
  '--no-consistency',
  '--no-cache',
  '--yes-spend',
  '--help',
  '-h',
] as const;

interface Args {
  brains: string[];
  window: string;
  symbol: string;
  interval: string;
  stride: number;
  maxDecisions?: number;
  probes: number;
  repeats: number;
  runConsistency: boolean;
  seed: number;
  faultLimit: number;
  endpoint: string;
  generation: number;
  thresholdsPath?: string;
  jsonPath?: string;
  noCache: boolean;
  yesSpend: boolean;
}

function usageLines(): string[] {
  const lines = [
    'usage: pnpm eval [options]',
    '',
    `  --brain <a,b>        default: ${freeBrainNames().join(',')}`,
  ];
  for (const name of brainNames()) {
    lines.push(`      ${name.padEnd(16)} [${BRAINS[name]!.kind}] ${BRAINS[name]!.describe}`);
  }
  lines.push('  --window <name>      held-out window from services/evals/data/manifest.json');
  lines.push('  --symbol <sym>       symbol label for the run (default BTCUSDT)');
  lines.push('  --interval <iv>      interval label for the run (default 1h)');
  lines.push('  --stride N           decide every Nth eligible bar');
  lines.push('  --max-decisions N    cap the run, thinned evenly across the window');
  lines.push('  --probes N           consistency probes (default 24)');
  lines.push('  --repeats N          re-presentations per probe (default 3)');
  lines.push('  --no-consistency     skip the probe entirely');
  lines.push('  --seed N             seeds probe selection (default 1337)');
  lines.push('  --fault-limit N      consecutive throws that end the run as an outage (default 3)');
  lines.push('  --thresholds <file>  override the frozen pass bar; stamps RELAXED everywhere');
  lines.push('  --json <file>        write the full report');
  lines.push('  --endpoint <url>     adapter server (default http://127.0.0.1:8177)');
  lines.push('  --generation N       generation label for the adapter brain');
  lines.push('  --no-cache           bypass the inference response cache, at full price');
  lines.push('  --yes-spend          required before any paid brain runs');
  lines.push('');
  lines.push('exit codes');
  lines.push('  0 pass   1 brain is bad   2 bad usage   3 service down');
  lines.push('  4 held-out window not trustworthy   5 inconclusive (window underpowered)');
  return lines;
}

/** Thrown for anything the operator got wrong. Never reachable from a brain's behaviour. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseArgs(argv: string[]): Args {
  const valueFlags = new Set<string>(VALUE_FLAGS);
  const known = new Set<string>([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

  // A typo in a flag name would otherwise be ignored and silently change what was
  // measured — `--stide 4` running at stride 1 reports a number nobody asked for, under a
  // heading that says they did. Values of known flags are skipped so a path or a label may
  // legitimately start with two dashes.
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (valueFlags.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('--') && !known.has(token)) {
      throw new UsageError(`unknown flag ${token}`);
    }
  }

  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    // A flag whose value is missing or is itself a flag is a typo, not a default. Letting
    // `--max-decisions` become 0 and mean "no cap" is how a capped run silently becomes a
    // full one.
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} expects a value`);
    }
    return value;
  };

  const num = (flag: string, fallback: number, min: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new UsageError(`${flag} expects a number, got "${raw}"`);
    if (value < min) throw new UsageError(`${flag} must be >= ${min}, got ${value}`);
    return value;
  };

  const brains = argv.includes('--brain')
    ? get('--brain')!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : freeBrainNames();
  if (brains.length === 0) throw new UsageError('--brain listed no brains');

  return {
    brains,
    window: get('--window') ?? 'forward',
    symbol: get('--symbol') ?? DEFAULT_BACKTEST.symbol,
    interval: get('--interval') ?? DEFAULT_BACKTEST.interval,
    stride: num('--stride', 1, 1),
    maxDecisions: argv.includes('--max-decisions')
      ? num('--max-decisions', 0, 1)
      : undefined,
    probes: num('--probes', 24, 0),
    repeats: num('--repeats', 3, 0),
    runConsistency: !argv.includes('--no-consistency'),
    seed: num('--seed', 1337, Number.NEGATIVE_INFINITY),
    faultLimit: num('--fault-limit', 3, 1),
    endpoint: get('--endpoint') ?? 'http://127.0.0.1:8177',
    generation: num('--generation', 1, 0),
    thresholdsPath: argv.includes('--thresholds') ? get('--thresholds') : undefined,
    jsonPath: argv.includes('--json') ? get('--json') : undefined,
    noCache: argv.includes('--no-cache'),
    yesSpend: argv.includes('--yes-spend'),
  };
}

/**
 * Blocks a paid run that nobody asked for.
 *
 * The suite is meant to be run constantly, and a suite that can silently bill you is a
 * suite people stop running.
 */
function guardSpend(names: string[], args: Args, decisions: number): void {
  const paid = names.filter((n) => BRAINS[n]!.kind === 'paid');
  if (paid.length === 0) return;

  const perDecision =
    PAID_TOKENS.input * MEASURED_INPUT_PRICE_OG + PAID_TOKENS.output * MEASURED_OUTPUT_PRICE_OG;
  const calls = decisions + (args.runConsistency ? args.probes * args.repeats : 0);
  const estimate = calls * perDecision * paid.length;

  console.log(
    `  ${paid.join(', ')} is billed: ~${calls} calls x ${paid.length} brain(s) ` +
      `~= ${estimate.toFixed(4)} 0G` +
      (args.noCache ? '' : ' (cache hits are free)'),
  );
  if (!args.yesSpend) {
    throw new UsageError('refusing to spend without --yes-spend');
  }
}

/**
 * Severity order for the aggregate exit code, worst last.
 *
 * Not the numeric order: 5 (inconclusive) is a weaker statement than 1 (the brain is bad),
 * so a run where one brain failed and another was inconclusive must exit 1. Ranking is
 * explicit here rather than implied by the constants, so renumbering an exit code cannot
 * silently reorder it.
 */
const SEVERITY: ExitCode[] = [
  EXIT.pass,
  EXIT.inconclusive,
  EXIT.qualityFail,
  EXIT.serviceUnavailable,
];

function worse(a: ExitCode, b: ExitCode): ExitCode {
  return SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a;
}

async function main(): Promise<ExitCode> {
  const argv = process.argv.slice(2);

  // Help is a successful request for help. Exit 0 on stdout, because every CI wrapper ever
  // written treats a non-zero `--help` as a broken tool.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usageLines().join('\n'));
    return EXIT.pass;
  }

  const args = parseArgs(argv);
  for (const name of args.brains) {
    if (!BRAINS[name]) throw new UsageError(`unknown brain "${name}"`);
  }

  const cfg = {
    ...DEFAULT_BACKTEST,
    symbol: args.symbol,
    interval: args.interval,
    stride: args.stride,
  };
  const { thresholds, source, relaxed } = loadThresholds(args.thresholdsPath);

  let holdout;
  try {
    holdout = loadHoldout({ window: args.window, horizon: cfg.horizon });
  } catch (err) {
    console.error(`holdout unusable: ${(err as Error).message}`);
    return err instanceof HoldoutError ? EXIT.invalidHoldout : EXIT.usage;
  }

  const planned = Math.min(
    args.maxDecisions ?? Number.POSITIVE_INFINITY,
    Math.ceil(holdout.scoreable.length / Math.max(1, cfg.stride)),
  );

  console.log(
    `window "${holdout.name}" — ${holdout.candles.length} candles, ` +
      `${holdout.scoreable.length} held out`,
  );
  console.log(`  scoring ~${planned} decisions per brain, seed ${args.seed}`);
  if (planned < thresholds.minPoweredDecisions) {
    console.log(
      `  UNDERPOWERED: ${thresholds.minPoweredDecisions} decisions are needed to certify a ` +
        'PASS. Clean runs will report INCONCLUSIVE (exit 5).',
    );
  }
  if (relaxed) {
    console.log(`  RELAXED thresholds from ${source} — this run cannot certify anything.`);
  }
  console.log('');
  guardSpend(args.brains, args, planned);

  const reports: EvalReport[] = [];
  let worst: ExitCode = EXIT.pass;

  for (const name of args.brains) {
    let decide;
    try {
      decide = await BRAINS[name]!.create({
        candles: holdout.candles,
        cfg,
        endpoint: args.endpoint,
        generation: args.generation,
        seed: args.seed,
        noCache: args.noCache,
      });
    } catch (err) {
      // Construction failing is always reachability, never quality: nothing was decided.
      console.error(`\n${name}: could not start — ${(err as Error).message}`);
      worst = worse(worst, EXIT.serviceUnavailable);
      continue;
    }

    try {
      const report = await runEval({
        brain: name,
        decide,
        holdout,
        cfg,
        thresholds,
        thresholdsSource: source,
        thresholdsRelaxed: relaxed,
        seed: args.seed,
        probes: args.probes,
        repeats: args.repeats,
        runConsistency: args.runConsistency,
        maxDecisions: args.maxDecisions,
        faultLimit: args.faultLimit,
      });
      reports.push(report);
      console.log(formatReport(report));
      console.log('');
      if (report.verdict === 'FAIL') worst = worse(worst, EXIT.qualityFail);
      if (report.verdict === 'INCONCLUSIVE') worst = worse(worst, EXIT.inconclusive);
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        console.error(`\n${name}: SERVICE UNAVAILABLE — ${err.message}`);
        worst = worse(worst, EXIT.serviceUnavailable);
      } else if (err instanceof InsufficientDecisionsError) {
        console.error(`\n${name}: holdout too small — ${err.message}`);
        return EXIT.invalidHoldout;
      } else {
        throw err;
      }
    }
  }

  if (reports.length > 1) {
    console.log('=== summary ===');
    console.log(formatSummary(reports));
    console.log('');
  }
  for (const report of reports) {
    if (report.verdict !== 'PASS') console.log(failureSummary(report));
  }

  if (args.jsonPath) {
    mkdirSync(dirname(args.jsonPath), { recursive: true });
    writeFileSync(args.jsonPath, `${JSON.stringify(reports, null, 2)}\n`);
    console.log(`\nwrote ${args.jsonPath}`);
  }

  const banner =
    worst === EXIT.pass
      ? 'PASS'
      : worst === EXIT.qualityFail
        ? 'FAIL — at least one brain missed the decision-quality bar'
        : worst === EXIT.inconclusive
          ? 'INCONCLUSIVE — nothing failed, but the window cannot certify a pass'
          : 'SERVICE UNAVAILABLE — this says nothing about decision quality';
  console.log(`\nexit ${worst}: ${banner}${relaxed ? ' [RELAXED THRESHOLDS]' : ''}`);
  return worst;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n`);
      console.error(usageLines().join('\n'));
      process.exit(EXIT.usage);
    }
    // Anything reaching here is a defect in the suite itself: every way a brain can
    // misbehave is handled inside `runEval`, and every way the operator can is a
    // `UsageError` above. Saying so is more useful than a bare stack trace under a heading
    // that blames whoever typed the command.
    console.error('\ninternal error in the eval suite — a bug here, not in the brain');
    console.error(err);
    process.exit(EXIT.usage);
  });
