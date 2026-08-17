/**
 * Trace persistence. Local JSONL is the source of truth; 0G Storage holds the published
 * copy addressed by Merkle root.
 */
import type { Trace } from '../types.js';
import { NotImplementedError } from '../errors.js';

/**
 * Deterministic JSONL. Identical traces must produce identical bytes on every machine
 * and every run (invariant I4) — the Merkle root of this output is committed on-chain,
 * so any instability would break reproducibility of the whole lineage.
 */
export function serializeTraces(_traces: Trace[]): string {
  throw new NotImplementedError('serializeTraces');
}

export function parseTraces(_text: string): Trace[] {
  throw new NotImplementedError('parseTraces');
}

export function writeTraces(_path: string, _traces: Trace[]): Promise<void> {
  throw new NotImplementedError('writeTraces');
}

export function readTraces(_path: string): Promise<Trace[]> {
  throw new NotImplementedError('readTraces');
}
