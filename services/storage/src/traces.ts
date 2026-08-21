/**
 * Trace persistence. Local JSONL is the source of truth; 0G Storage holds the published
 * copy addressed by Merkle root.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Trace } from '../../../schemas/index.js';

/**
 * Keys are written explicitly rather than by spreading the object, so serialisation
 * cannot drift if a field is reordered in the type definition. The Merkle root of this
 * output is committed on-chain — silent instability here would break reproducibility of
 * an entire lineage.
 */
function serializeTrace(trace: Trace): string {
  const { snapshot, decision, outcome } = trace;
  const f = snapshot.features;

  return JSON.stringify({
    id: trace.id,
    snapshot: {
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      at: snapshot.at,
      close: snapshot.close,
      features: {
        ret1: f.ret1,
        ret6: f.ret6,
        ret24: f.ret24,
        smaDist24: f.smaDist24,
        rsi14: f.rsi14,
        atrPct14: f.atrPct14,
        volRatio24: f.volRatio24,
        volOfVol: f.volOfVol,
      },
    },
    decision: {
      action: decision.action,
      confidence: decision.confidence,
      rationale: decision.rationale,
      generation: decision.generation,
      model: decision.model,
    },
    outcome: {
      forwardReturn: outcome.forwardReturn,
      realizedReturn: outcome.realizedReturn,
      hindsight: outcome.hindsight,
      correct: outcome.correct,
    },
  });
}

/**
 * Deterministic JSONL, ordered by bar time. Identical traces produce identical bytes
 * regardless of input ordering (invariant I4).
 */
export function serializeTraces(traces: Trace[]): string {
  return [...traces]
    .sort((a, b) => a.snapshot.at - b.snapshot.at || a.id.localeCompare(b.id))
    .map(serializeTrace)
    .join('\n');
}

export function parseTraces(text: string): Trace[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Trace);
}

export async function writeTraces(path: string, traces: Trace[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeTraces(traces), 'utf8');
}

export async function readTraces(path: string): Promise<Trace[]> {
  return parseTraces(await readFile(path, 'utf8'));
}
