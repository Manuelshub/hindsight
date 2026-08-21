/**
 * Decision-quality eval suite — entry point.
 *
 *   pnpm tsx evals/quality/cli.ts                          # every free brain, held-out window
 *   pnpm tsx evals/quality/cli.ts --brain adapter          # the local LoRA, generation 1
 *   pnpm tsx evals/quality/cli.ts --brain remote --yes-spend --max-decisions 150
 *
 * Exit codes are the interface. 0 pass, 1 the brain is bad, 2 bad usage, 3 the service is
 * down, 4 the held-out window cannot be trusted. See `harness/types.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULT_BACKTEST, MEASURED_INPUT_PRICE_OG, MEASURED_OUTPUT_PRICE_OG } from './harness/project.js';
import { BRAINS, freeBrainNames, brainNames } from './harness/brains.js';
import { HoldoutError, loadHoldout } from './harness/holdout.js';
import { formatReport, formatSummary, failureSummary } from './harness/report.js';
import {
  InsufficientDecisionsError,
  ServiceUnavailableError,
  runEval,
} from './harness/run.js';
import { loadThresholds } from './harness/thresholds.js';
import { EXIT } from './harness/types.js';
import type { EvalReport, ExitCode } from './harness/types.js';

/** Rough per-decision spend for a paid brain, from the measured gen-0 token counts. */
const PAID_TOKENS = { input: 330, output: 20 };

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

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const brains = get('--brain');

  return {
    brains: brains ? brains.split(',').map((s) => s.trim()) : freeBrainNames(),
    window: get('--window') ?? 'forward',
    symbol: get('--symbol') ?? DEFAULT_BACKTEST.symbol,
    interval: get('--interval') ?? DEFAULT_BACKTEST.interval,
    stride: Number(get('--stride') ?? 1),
    maxDecisions: get('--max-decisions') ? Number(get('--max-decisions')) : undefined,
    probes: Number(get('--probes') ?? 24),
    repeats: Number(get('--repeats') ?? 3),
    runConsistency: !argv.includes('--no-consistency'),
    seed: Number(get('--seed') ?? 1337),
    faultLimit: Number(get('--fault-limit') ?? 3),
    endpoint: get('--endpoint') ?? 'http://127.0.0.1:8177',
    generation: Number(get('--generation') ?? 1),
    thresholdsPath: get('--thresholds'),
    jsonPath: get('--json'),
    noCache: argv.includes('--no-cache'),
    yesSpend: argv.includes('--yes-spend'),
  };
}

function usage(message: string): never {
  console.error(`error: ${message}\n`);
  console.error('usage: pnpm tsx evals/quality/cli.ts [options]\n');
  console.error(`  --brain <a,b>        default: ${freeBrainNames().join(',')}`);
  for (const name of brainNames()) {
    console.error(`      ${name.padEnd(16)} [${BRAINS[name]!.kind}] ${BRAINS[name]!.describe}`);
  }
  console.error('  --window <name>      held-out window from evals/quality/data/manifest.json');
  console.error('  --stride N           decide every Nth eligible bar');
  console.error('  --max-decisions N    cap the run, thinned evenly across the window');
  console.error('  --probes N           consistency probes (default 24)');
  console.error('  --repeats N          re-presentations per probe (default 3)');
  console.error('  --no-consistency     skip the probe entirely');
  console.error('  --seed N             seeds probe selection (default 1337)');
  console.error('  --thresholds <file>  override the frozen pass bar');
  console.error('  --json <file>        write the full report');
  console.error('  --endpoint <url>     adapter server (default http://127.0.0.1:8177)');
  console.error('  --generation N       generation label for the adapter brain');
  console.error('  --no-cache           bypass the inference response cache, at full price');
  console.error('  --yes-spend          required before any paid brain runs');
  process.exit(EXIT.usage);
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
    console.error('\nrefusing to spend without --yes-spend');
    process.exit(EXIT.usage);
  }
}

async function main(): Promise<ExitCode> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) usage('help requested');

  const args = parseArgs(argv);
  for (const name of args.brains) {
    if (!BRAINS[name]) usage(`unknown brain "${name}"`);
  }
  if (!Number.isFinite(args.seed)) usage('--seed must be a number');

  const cfg = {
    ...DEFAULT_BACKTEST,
    symbol: args.symbol,
    interval: args.interval,
    stride: args.stride,
  };
  const { thresholds, source } = loadThresholds(args.thresholdsPath);

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

  console.log(`window "${holdout.name}" — ${holdout.candles.length} candles, ${holdout.scoreable.length} held out`);
  console.log(`  scoring ~${planned} decisions per brain, seed ${args.seed}\n`);
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
      worst = EXIT.serviceUnavailable;
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
      if (report.verdict === 'FAIL' && worst === EXIT.pass) worst = EXIT.qualityFail;
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        console.error(`\n${name}: SERVICE UNAVAILABLE — ${err.message}`);
        worst = EXIT.serviceUnavailable;
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
    if (report.verdict === 'FAIL') console.log(failureSummary(report));
  }

  if (args.jsonPath) {
    mkdirSync(dirname(args.jsonPath), { recursive: true });
    writeFileSync(args.jsonPath, `${JSON.stringify(reports, null, 2)}\n`);
    console.log(`\nwrote ${args.jsonPath}`);
  }

  console.log(`\nexit ${worst}`);
  return worst;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(EXIT.usage);
  });
