/**
 * Runs one generation of the agent over market data and records the result.
 *
 *   tsx src/cli/run-generation.ts [--generation N] [--bars N] [--stride N]
 *                                 [--symbol S] [--interval I] [--dry-run]
 *
 * Generation 0 uses 0G Compute inference (billed). Later generations will use a locally
 * served LoRA adapter and cost nothing.
 *
 * Every response is cached by snapshot hash under runs/cache, so re-running the same
 * window is free. Deleting that directory means paying again.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

import {
  LEDGER_MINIMUM_OG,
  TESTNET,
  inferenceProvider,
  requirePrivateKey,
  runDir,
} from '../config.js';
import { getCandles } from '../market/feed.js';
import { RATE_LIMIT_PER_MIN, createInferenceBrain } from '../agent/inference.js';
import { computeStats, formatStats, runBacktest } from '../sim/backtest.js';
import { writeTraces } from '../storage/traces.js';
import { DEFAULT_BACKTEST } from '../types.js';
import { BASELINES, type BaselineName } from '../agent/baseline.js';

interface Args {
  generation: number;
  bars: number;
  stride: number;
  symbol: string;
  interval: string;
  dryRun: boolean;
  baseline?: BaselineName;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    generation: Number(get('--generation') ?? 0),
    bars: Number(get('--bars') ?? 3000),
    stride: Number(get('--stride') ?? 4),
    symbol: get('--symbol') ?? DEFAULT_BACKTEST.symbol,
    interval: get('--interval') ?? DEFAULT_BACKTEST.interval,
    dryRun: argv.includes('--dry-run'),
    baseline: get('--baseline') as BaselineName | undefined,
  };
}

/** Ensures the compute ledger exists and holds enough to run. */
async function ensureLedger(privateKey: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(TESTNET.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const broker = await createZGComputeNetworkBroker(wallet);

  try {
    const ledger = await broker.ledger.getLedger();
    const balance = Number(ethers.formatEther(ledger.totalBalance ?? 0n));
    console.log(`  ledger balance: ${balance.toFixed(4)} 0G`);
    return balance;
  } catch {
    console.log(`  no ledger found — opening one with ${LEDGER_MINIMUM_OG} 0G`);
    const walletBalance = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
    if (walletBalance < LEDGER_MINIMUM_OG) {
      throw new Error(
        `wallet holds ${walletBalance.toFixed(4)} 0G but the ledger minimum is ` +
          `${LEDGER_MINIMUM_OG} 0G — claim from https://faucet.0g.ai and retry`,
      );
    }
    await broker.ledger.addLedger(LEDGER_MINIMUM_OG);
    console.log('  ledger opened');
    return LEDGER_MINIMUM_OG;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = {
    ...DEFAULT_BACKTEST,
    symbol: args.symbol,
    interval: args.interval,
    stride: args.stride,
  };
  const dir = runDir(args.generation);

  console.log(`\n=== generation ${args.generation} ===`);
  console.log(`  symbol ${cfg.symbol} ${cfg.interval}  bars ${args.bars}  stride ${cfg.stride}`);

  const candles = await getCandles({ symbol: cfg.symbol, interval: cfg.interval, limit: args.bars });
  const from = new Date(candles[0]!.openTime).toISOString().slice(0, 16);
  const to = new Date(candles.at(-1)!.closeTime).toISOString().slice(0, 16);
  console.log(`  window ${from} -> ${to}`);

  // Baseline mode costs nothing and is the control for everything that follows.
  if (args.baseline) {
    const decide = BASELINES[args.baseline];
    if (!decide) throw new Error(`unknown baseline: ${args.baseline}`);
    const traces = await runBacktest(candles, decide, cfg);
    const stats = computeStats(traces, cfg);
    await mkdir(dir, { recursive: true });
    await writeTraces(`${dir}/traces.jsonl`, traces);
    await writeFile(`${dir}/stats.json`, `${JSON.stringify(stats, null, 2)}\n`);
    console.log(`\n${formatStats(stats)}`);
    console.log(`\n  wrote ${dir}/traces.jsonl`);
    return;
  }

  const decisions = Math.ceil((candles.length - 50 - cfg.horizon) / cfg.stride);
  const projected = decisions * 0.00045;
  // The provider caps us at 10 requests/minute, so wall time is the real constraint on a
  // full run, not cost.
  const minutes = Math.ceil(decisions / RATE_LIMIT_PER_MIN);
  console.log(
    `  ~${decisions} decisions, projected cost ~${projected.toFixed(4)} 0G, ` +
      `~${minutes} min at ${RATE_LIMIT_PER_MIN} req/min`,
  );

  if (args.dryRun) {
    console.log('\n  --dry-run: stopping before any spend');
    return;
  }

  const privateKey = requirePrivateKey();
  await ensureLedger(privateKey);

  const brain = await createInferenceBrain({
    providerAddress: inferenceProvider(),
    rpcUrl: TESTNET.rpcUrl,
    privateKey,
    cacheDir: 'runs/cache',
    generation: args.generation,
  });

  let lastReport = Date.now();
  const traces = await runBacktest(candles, brain.decide, cfg, (done, total) => {
    if (Date.now() - lastReport > 5000) {
      lastReport = Date.now();
      const pct = ((done / total) * 100).toFixed(0);
      console.log(
        `  ${done}/${total} (${pct}%)  requests=${brain.requests()} ` +
          `cached=${brain.cacheHits()}  429s=${brain.rateLimitHits()}  ` +
          `spent~${brain.spentOG().toFixed(4)} 0G`,
      );
    }
  });

  const stats = computeStats(traces, cfg);
  await mkdir(dir, { recursive: true });
  await writeTraces(`${dir}/traces.jsonl`, traces);
  await writeFile(
    `${dir}/stats.json`,
    `${JSON.stringify(
      {
        ...stats,
        parseFailureRate: brain.parseFailureRate(),
        verifiedRate: brain.verifiedRate(),
        estimatedSpendOG: brain.spentOG(),
        window: { from, to },
        config: cfg,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n${formatStats(stats)}`);
  console.log(`  parse failures ${(brain.parseFailureRate() * 100).toFixed(2)}%`);
  console.log(`  TEE verified   ${(brain.verifiedRate() * 100).toFixed(2)}%`);
  console.log(`  spent          ~${brain.spentOG().toFixed(4)} 0G`);
  console.log(`\n  wrote ${dir}/traces.jsonl and ${dir}/stats.json`);
}

main().catch((err) => {
  console.error(`\nfailed: ${(err as Error).message}`);
  process.exit(1);
});
