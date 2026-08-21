/**
 * Operator dashboard. Answers, in one place, the questions that decide what to do next:
 * can we afford a run, is the shared trainer free, and is anything about to be forfeited.
 *
 *   tsx src/cli/status.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import * as sdk from '@0gfoundation/0g-compute-ts-sdk';

import {
  LEDGER_MINIMUM_OG,
  TESTNET,
  fineTuningProvider,
  lineageRegistryAddress,
  requirePrivateKey,
} from '../config/index.js';
import {
  FORFEIT_WINDOW_HOURS,
  type TaskRecord,
  hoursUntilForfeit,
} from '../services/training/src/orchestrator.js';

async function walletAndLedger(): Promise<void> {
  const privateKey = requirePrivateKey();
  const provider = new ethers.JsonRpcProvider(TESTNET.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('WALLET');
  console.log(`  address   ${wallet.address}`);
  const balance = Number(ethers.formatEther(await provider.getBalance(wallet.address)));
  console.log(`  testnet   ${balance.toFixed(4)} 0G`);

  try {
    const broker = await sdk.createZGComputeNetworkBroker(wallet);
    const ledger = await broker.ledger.getLedger();
    const total = Number(ethers.formatEther(ledger.totalBalance ?? 0n));
    console.log(`  ledger    ${total.toFixed(4)} 0G`);
    if (total < 0.05) console.log('  ⚠ ledger nearly empty — top up before the next run');
  } catch {
    console.log(`  ledger    none (opens at ${LEDGER_MINIMUM_OG} 0G)`);
  }
}

async function providerStatus(): Promise<void> {
  console.log('\nFINE-TUNING PROVIDER');
  try {
    const broker = await (sdk as any).createZGComputeNetworkReadOnlyBroker(TESTNET.rpcUrl);
    const services = await broker.fineTuning.listService();
    const target = fineTuningProvider().toLowerCase();
    const mine = services.find((s: any) => String(s.provider).toLowerCase() === target);

    if (!mine) {
      console.log(`  ⚠ ${fineTuningProvider()} not currently registered`);
      return;
    }
    console.log(`  address   ${mine.provider}`);
    console.log(`  occupied  ${mine.occupied}`);
    if (mine.occupied) {
      console.log('  ⚠ busy — the single network-wide trainer is in use, queue and wait');
    }
  } catch (err) {
    console.log(`  unreachable — ${(err as Error).message}`);
  }
}

async function tasks(): Promise<void> {
  console.log('\nTASKS');
  let dirs: string[];
  try {
    dirs = (await readdir('runs', { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('gen-'))
      .map((d) => d.name);
  } catch {
    console.log('  no runs yet');
    return;
  }

  if (dirs.length === 0) {
    console.log('  no runs yet');
    return;
  }

  const now = Date.now();
  for (const dir of dirs.sort()) {
    let record: TaskRecord | undefined;
    try {
      record = JSON.parse(await readFile(`runs/${dir}/state.json`, 'utf8')) as TaskRecord;
    } catch {
      // A generation with traces but no task state has been run but never trained.
      let traces = 0;
      try {
        traces = (await readFile(`runs/${dir}/traces.jsonl`, 'utf8')).trimEnd().split('\n').length;
      } catch {
        /* nothing recorded */
      }
      console.log(`  ${dir.padEnd(10)} ${traces} traces, not yet trained`);
      continue;
    }

    let line = `  ${dir.padEnd(10)} ${record.state}`;
    if (record.state === 'DELIVERED' && record.deliveredAt !== undefined) {
      const left = hoursUntilForfeit(record.deliveredAt, now);
      line += `  ${left.toFixed(1)}h of ${FORFEIT_WINDOW_HOURS} remaining`;
      if (left < 24) line += '   ⚠ ACKNOWLEDGE NOW';
    }
    console.log(line);
  }
}

async function main() {
  console.log('\n=== hindsight status ===\n');
  await walletAndLedger();
  await providerStatus();
  await tasks();

  console.log('\nLINEAGE REGISTRY');
  const address = lineageRegistryAddress();
  console.log(address ? `  ${address}` : '  not deployed — mainnet contract still pending');
  console.log();
}

main().catch((err) => {
  console.error(`status failed: ${(err as Error).message}`);
  process.exit(1);
});
