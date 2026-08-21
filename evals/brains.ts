/**
 * Resolves a brain name to a DecideFn.
 *
 * This is the only file in the suite that knows a remote provider or a Python sidecar
 * exists. Everything downstream sees `Brain`, so adding generation 2 means adding a case
 * here and nothing else — and no metric can quietly acquire a special case for the model
 * it happens to like.
 *
 * The paid brain is constructed lazily. Importing the 0G SDK at module load would mean a
 * `pnpm eval` against a baseline pays a second of startup and needs a private key in the
 * environment to do nothing with.
 */
import { BASELINES, type BaselineName } from '../src/agent/baseline.js';
import type { Brain } from './harness.js';
import { ServiceUnavailableError, UsageError } from './exit-codes.js';

export interface BrainRequest {
  name: string;
  /** Sidecar base URL for the local adapter brain. */
  endpoint: string;
  /** Which generation the adapter is serving; also stamped on its decisions. */
  generation: number;
  /** Response cache directory for the metered remote brain. Empty disables it. */
  cacheDir: string;
  /** Explicit opt-in required before anything bills. */
  allowPaid: boolean;
}

export const BASELINE_NAMES = Object.keys(BASELINES) as BaselineName[];

/** Measured on testnet: cost of one generation-0 decision, per README. */
const OG_PER_DECISION = 0.00045;

export function projectedCostOG(name: string, decisions: number): number {
  return name === 'inference' ? decisions * OG_PER_DECISION : 0;
}

/**
 * Errors during construction are transport errors by definition: nothing has been asked
 * of the model yet, so a failure here can only be the service or the wiring, never the
 * quality of the brain. Classifying it correctly is what keeps a dead sidecar out of the
 * quality record.
 */
export async function resolveBrain(request: BrainRequest): Promise<Brain> {
  const { name } = request;

  if (name in BASELINES) {
    return {
      name,
      decide: BASELINES[name as BaselineName],
      free: true,
      cachedResponses: false,
    };
  }

  if (name === 'adapter') {
    const { createAdapterBrain } = await import('../src/agent/adapter.js');
    const brain = await createAdapterBrain({
      endpoint: request.endpoint,
      generation: request.generation,
    }).catch((err: Error) => {
      throw new ServiceUnavailableError(err.message);
    });
    // Free to run but not offline, so it is still an opt-in away from the default.
    return { name, decide: brain.decide, free: true, cachedResponses: false };
  }

  if (name === 'inference') {
    if (!request.allowPaid) {
      throw new UsageError(
        'brain "inference" bills 0G per decision — re-run with --allow-paid to authorise it',
      );
    }

    const [{ createInferenceBrain }, config] = await Promise.all([
      import('../src/agent/inference.js'),
      import('../src/config.js'),
    ]);

    const brain = await createInferenceBrain({
      providerAddress: config.inferenceProvider(),
      rpcUrl: config.TESTNET.rpcUrl,
      privateKey: config.requirePrivateKey(),
      cacheDir: request.cacheDir || undefined,
      generation: request.generation,
    }).catch((err: Error) => {
      throw new ServiceUnavailableError(err.message);
    });

    return {
      name,
      decide: brain.decide,
      free: false,
      // With a cache on, a re-asked snapshot is answered from disk, so the consistency
      // probe measures the cache and not the model. Reported, never silently ignored.
      cachedResponses: request.cacheDir.length > 0,
    };
  }

  throw new UsageError(
    `unknown brain "${name}". options: ${[...BASELINE_NAMES, 'adapter', 'inference'].join(', ')}`,
  );
}
