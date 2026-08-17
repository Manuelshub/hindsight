/**
 * Generation-0 brain: decisions from 0G Compute inference, TEE-attested.
 */
import type { Decision, MarketSnapshot, Side } from '../types.js';
import type { DecideFn } from '../sim/backtest.js';
import { NotImplementedError } from '../errors.js';

/**
 * Extracts an action from a raw model response.
 *
 * Deliberately strict. A model that rambles instead of answering has not done the task,
 * and silently coercing that into FLAT would hide the failure inside a plausible-looking
 * accuracy number. Returns null so the caller can count it as a parse failure.
 */
export function parseAction(_raw: string): Side | null {
  throw new NotImplementedError('parseAction');
}

export interface InferenceBrainOptions {
  providerAddress: string;
  rpcUrl: string;
  privateKey: string;
  /** Cache responses by snapshot hash so re-running a backtest never re-bills. */
  cacheDir?: string;
  maxConcurrency?: number;
  /** Verify each response against the provider's TEE signature. */
  verify?: boolean;
}

export interface InferenceBrain {
  decide: DecideFn;
  /** Fraction of responses that could not be parsed into an action. */
  parseFailureRate(): number;
  /** Fraction of responses whose TEE signature verified. */
  verifiedRate(): number;
  /** Total 0G spent by this brain so far. */
  spentOG(): number;
}

export function createInferenceBrain(_options: InferenceBrainOptions): Promise<InferenceBrain> {
  throw new NotImplementedError('createInferenceBrain');
}

/** Stable hash of a snapshot, used as the response cache key. */
export function snapshotHash(_snapshot: MarketSnapshot): string {
  throw new NotImplementedError('snapshotHash');
}

/** Builds the chat messages sent to the model for a given snapshot. */
export function buildMessages(
  _snapshot: MarketSnapshot,
): Array<{ role: 'system' | 'user'; content: string }> {
  throw new NotImplementedError('buildMessages');
}

export function toDecision(
  _action: Side,
  _raw: string,
  _generation: number,
  _model: string,
): Decision {
  throw new NotImplementedError('toDecision');
}
