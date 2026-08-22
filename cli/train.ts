/**
 * Drives one fine-tuning generation on 0G Compute.
 *
 *   tsx src/cli/train.ts --from 0 --to 1 [--dry-run] [--yes] [--watch]
 *
 * Resumable: every phase persists to runs/gen-<to>/state.json, so a crash or a killed
 * terminal picks up where it left off rather than paying for the task twice.
 *
 * The 48-hour forfeit window is the reason this is a state machine and not a script. Once
 * a task reaches Delivered, the adapter must be acknowledged and downloaded within 48h or
 * it is lost along with 30% of the fee.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

import { TESTNET, fineTuningProvider, requirePrivateKey, runDir } from '../config/index.js';
import { readTraces } from '../services/storage/src/traces.js';
import {
  buildCurriculum,
  estimateCostOG,
  estimateTokens,
  serializeCurriculum,
} from '../services/agent/src/curriculum.js';
import { DEFAULT_TRAINING_CONFIG } from '../services/lineage/src/hash.js';
import {
  type TaskRecord,
  hoursUntilForfeit,
  loadTaskRecord,
  saveTaskRecord,
} from '../services/training/src/orchestrator.js';

const BASE_MODEL = 'Qwen2.5-0.5B-Instruct';
const POLL_INTERVAL_MS = 60_000;

interface Args {
  from: number;
  to: number;
  dryRun: boolean;
  yes: boolean;
  watch: boolean;
  epochs: number;
  /** Token budget for the dataset. Cost scales linearly with it. */
  maxTokens?: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const from = Number(get('--from') ?? 0);
  return {
    from,
    to: Number(get('--to') ?? from + 1),
    dryRun: argv.includes('--dry-run'),
    yes: argv.includes('--yes'),
    watch: argv.includes('--watch'),
    epochs: Number(get('--epochs') ?? DEFAULT_TRAINING_CONFIG.num_train_epochs),
    maxTokens: get('--max-tokens') ? Number(get('--max-tokens')) : undefined,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Builds dataset.jsonl and config.json for the target generation. */
async function prepare(args: Args): Promise<{ dir: string; tokens: number; cost: number }> {
  const sourceDir = runDir(args.from);
  const dir = runDir(args.to);
  await mkdir(dir, { recursive: true });

  const traces = await readTraces(`${sourceDir}/traces.jsonl`);
  const examples = buildCurriculum(
    traces,
    args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens },
  );
  const tokens = estimateTokens(examples);
  const cost = estimateCostOG(examples, args.epochs, 8e-7);

  const counts: Record<string, number> = {};
  for (const e of examples) counts[e.output] = (counts[e.output] ?? 0) + 1;

  console.log(`  source          gen-${args.from} (${traces.length} traces)`);
  console.log(`  examples        ${examples.length}  ${JSON.stringify(counts)}`);
  console.log(`  tokens          ${tokens}`);
  console.log(`  epochs          ${args.epochs}`);
  console.log(`  projected cost  ${cost.toFixed(4)} 0G`);

  await writeFile(`${dir}/dataset.jsonl`, `${serializeCurriculum(examples)}\n`, 'utf8');

  // The provider rejects configs with added or removed keys; only values may change.
  const config = { ...DEFAULT_TRAINING_CONFIG, num_train_epochs: args.epochs };
  await writeFile(`${dir}/config.json`, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`  wrote           ${dir}/dataset.jsonl and ${dir}/config.json`);
  return { dir, tokens, cost };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n=== train gen-${args.from} -> gen-${args.to} ===`);

  const { dir, cost } = await prepare(args);
  const statePath = `${dir}/state.json`;

  if (args.dryRun) {
    console.log('\n  --dry-run: dataset built, nothing submitted');
    return;
  }

  const privateKey = requirePrivateKey();
  const provider = new ethers.JsonRpcProvider(TESTNET.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const broker = await createZGComputeNetworkBroker(wallet);
  if (!broker.fineTuning) throw new Error('fine-tuning broker unavailable on this network');

  const providerAddress = fineTuningProvider();

  let record: TaskRecord =
    (await loadTaskRecord(statePath)) ??
    ({
      generation: args.to,
      state: 'PENDING',
      provider: providerAddress,
      datasetPath: `${dir}/dataset.jsonl`,
      updatedAt: Date.now(),
    } satisfies TaskRecord);

  console.log(`\n  resuming from state: ${record.state}`);

  // --- fund -----------------------------------------------------------------
  if (record.state === 'PENDING') {
    const services = await broker.fineTuning.listService();
    const target = services.find(
      (s: any) => String(s.provider).toLowerCase() === providerAddress.toLowerCase(),
    );
    if (!target) throw new Error(`provider ${providerAddress} is not registered`);
    if ((target as any).occupied) {
      throw new Error('the single network-wide trainer is busy — retry later');
    }

    // The broker sweeps the whole ledger balance into a provider sub-account on first
    // use, so funds spent on inference are not available here. Check what this
    // sub-account already holds before moving more, or a resumed run double-funds.
    const existing = await broker.ledger.getProvidersWithBalance('fine-tuning');
    const held = existing.find(
      ([addr]) => String(addr).toLowerCase() === providerAddress.toLowerCase(),
    );
    const heldOG = held ? Number(ethers.formatEther(held[1])) : 0;

    // Three times the projection, because the provider bills actual tokens rather than
    // our estimate. The provider also warns below 1 0G, so that is the floor we top up
    // toward — but only when the balance does not already cover the run. Chasing the
    // floor when it does turns a funded task into a failed transfer over rounding dust.
    const needed = cost * 3;
    const targetFunding = Math.max(1, needed);

    if (heldOG >= needed) {
      console.log(
        `  sub-account holds ${heldOG.toFixed(4)} 0G, run needs ~${needed.toFixed(4)} 0G` +
          ' — skipping transfer',
      );
    } else {
      // Never ask for more than the ledger can actually release.
      const ledger = await broker.ledger.getLedger();
      const available = Number(ethers.formatEther(ledger.availableBalance ?? 0n));
      const fund = Math.min(targetFunding - heldOG, available);

      if (fund <= 0) {
        throw new Error(
          `sub-account holds ${heldOG.toFixed(4)} 0G, run needs ${needed.toFixed(4)} 0G, ` +
            'and the ledger has nothing available — deposit more before retrying',
        );
      }

      console.log(`  funding provider sub-account with ${fund.toFixed(4)} 0G`);
      await broker.ledger.transferFund(
        providerAddress,
        'fine-tuning',
        ethers.parseEther(fund.toFixed(18)),
      );
    }

    // Required once per provider before any task will be accepted.
    try {
      await broker.fineTuning.acknowledgeProviderSigner(providerAddress);
      console.log('  acknowledged provider signer');
    } catch (err) {
      console.log(`  provider signer already acknowledged (${(err as Error).message.slice(0, 60)})`);
    }

    record = { ...record, state: 'FUNDED', updatedAt: Date.now() };
    await saveTaskRecord(statePath, record);
  }

  // --- submit ---------------------------------------------------------------
  if (record.state === 'FUNDED') {
    console.log('  uploading dataset to 0G Storage...');
    const datasetRoot = await broker.fineTuning.uploadDataset(record.datasetPath);
    console.log(`  datasetRoot ${datasetRoot}`);

    console.log('  creating task...');
    const taskId = await broker.fineTuning.createTask(
      providerAddress,
      BASE_MODEL,
      datasetRoot,
      `${dir}/config.json`,
    );
    console.log(`  taskId ${taskId}`);

    record = {
      ...record,
      state: 'SUBMITTED',
      taskId,
      datasetRoot,
      updatedAt: Date.now(),
    };
    await saveTaskRecord(statePath, record);
  }

  // --- poll -----------------------------------------------------------------
  if (!args.watch) {
    console.log(`\n  submitted. poll with:  pnpm train -- --from ${args.from} --to ${args.to} --watch`);
    return;
  }

  console.log('\n  watching (Ctrl-C is safe; state is persisted)');
  for (;;) {
    const task = await broker.fineTuning.getTask(providerAddress, record.taskId);
    const progress = String((task as any).progress ?? 'unknown');
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${progress}`);

    if (/deliver/i.test(progress) && record.state !== 'DELIVERED') {
      record = {
        ...record,
        state: 'DELIVERED',
        deliveredAt: record.deliveredAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      await saveTaskRecord(statePath, record);
    }

    if (record.state === 'DELIVERED' && record.deliveredAt) {
      const left = hoursUntilForfeit(record.deliveredAt, Date.now());
      console.log(`  delivered — ${left.toFixed(1)}h before forfeit; acknowledging now`);

      const encrypted = `${dir}/model-encrypted.bin`;
      await broker.fineTuning.acknowledgeModel(providerAddress, record.taskId!, encrypted);
      record = { ...record, state: 'ACKNOWLEDGED', updatedAt: Date.now() };
      await saveTaskRecord(statePath, record);

      // The provider publishes `encryptedSecret` on-chain a little after the
      // acknowledgement is mined, so decrypting immediately fails with an opaque
      // "second arg must be public key". Retry rather than surfacing that to the user.
      const decrypted = `${dir}/adapter.zip`;
      for (let attempt = 1; ; attempt++) {
        try {
          await broker.fineTuning.decryptModel(
            providerAddress,
            record.taskId!,
            encrypted,
            decrypted,
          );
          break;
        } catch (err) {
          if (attempt >= 10) throw err;
          console.log(`  decryption key not published yet (attempt ${attempt}), waiting 30s`);
          await sleep(30_000);
        }
      }
      record = {
        ...record,
        state: 'DECRYPTED',
        adapterPath: decrypted,
        updatedAt: Date.now(),
      };
      await saveTaskRecord(statePath, record);

      console.log(`\n  adapter at ${decrypted}`);
      return;
    }

    if (/fail|error|cancel/i.test(progress)) {
      record = { ...record, state: 'FAILED', error: progress, updatedAt: Date.now() };
      await saveTaskRecord(statePath, record);
      throw new Error(`task failed: ${progress}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(`\nfailed: ${(err as Error).message}`);
  process.exit(1);
});
