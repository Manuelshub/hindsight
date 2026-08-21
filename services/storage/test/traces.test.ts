/**
 * Specification for trace persistence. Currently red.
 *
 * The Merkle root of this serialisation is what gets committed on-chain, so instability
 * here would silently break reproducibility of an entire lineage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTraces, serializeTraces } from '../src/traces.js';
import { makeMistakes, makeTraces } from '../../../schemas/fixtures.js';

describe('serializeTraces — determinism (I4)', () => {
  it('is byte-identical across repeated calls', () => {
    const traces = makeMistakes(25);
    assert.equal(serializeTraces(traces), serializeTraces(traces));
  });

  it('is insensitive to input ordering', () => {
    const traces = makeMistakes(25);
    assert.equal(serializeTraces(traces), serializeTraces([...traces].reverse()));
  });

  it('emits one JSON object per line', () => {
    const jsonl = serializeTraces(makeMistakes(5));
    const lines = jsonl.trim().split('\n');
    assert.equal(lines.length, 5);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });

  it('orders lines by snapshot time', () => {
    const jsonl = serializeTraces([...makeMistakes(10)].reverse());
    const times = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).snapshot.at as number);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
});

describe('round-trip', () => {
  it('parses back to structurally identical traces', () => {
    const traces = makeTraces([
      ['LONG', 'SHORT'],
      ['FLAT', 'FLAT'],
      ['SHORT', 'LONG'],
    ]);
    assert.deepEqual(parseTraces(serializeTraces(traces)), traces);
  });

  it('survives a second round-trip unchanged', () => {
    const once = serializeTraces(makeMistakes(12));
    assert.equal(serializeTraces(parseTraces(once)), once);
  });

  it('tolerates a trailing newline', () => {
    const jsonl = serializeTraces(makeMistakes(3));
    assert.equal(parseTraces(`${jsonl}\n`).length, 3);
  });

  it('preserves the outcome fields that carry the learning signal', () => {
    const [trace] = parseTraces(serializeTraces(makeTraces([['LONG', 'SHORT']])));
    assert.equal(trace!.outcome.hindsight, 'SHORT');
    assert.equal(trace!.decision.action, 'LONG');
    assert.equal(trace!.outcome.correct, false);
  });
});
