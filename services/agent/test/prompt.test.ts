/**
 * Regression tests for the generation-1 failure.
 *
 * Generation 1 never emitted FLAT and its output did not depend on its input. Two causes
 * are addressable here: the training text did not contain the served text, and FLAT
 * tokenises as two tokens where LONG and SHORT take one. These tests fail if either
 * regresses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FROM_WIRE,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  WIRE,
  WIRE_WORDS,
  servingPrompt,
} from '../src/prompt.js';
import { buildMessages, parseAction } from '../src/inference.js';
import { CLASS_WEIGHT, buildCurriculum } from '../src/curriculum.js';
import { makeSnapshot, makeTraces } from '../../../schemas/fixtures.js';
import type { Side } from '../../../schemas/index.js';

describe('training text contains the served text', () => {
  it('a training example embeds the served prompt verbatim', () => {
    // The exact defect in generation 1: the model trained on a bare snapshot and was then
    // served a 67-token system prompt plus an "Action:" suffix it had never seen.
    const traces = makeTraces([['LONG', 'FLAT']]);
    const [example] = buildCurriculum(traces, { balanceClasses: false, correctRatio: 0 });
    const served = servingPrompt(traces[0]!.snapshot);

    assert.equal(example!.input, served, 'training input diverged from the served prompt');
  });

  it('the served chat messages reconstruct the same prompt body', () => {
    const snapshot = makeSnapshot();
    const messages = buildMessages(snapshot);
    const reconstructed = `${messages[0]!.content}\n\n${messages.at(-1)!.content}`;

    assert.equal(reconstructed, servingPrompt(snapshot));
  });

  it('the system prompt is present in both halves', () => {
    const snapshot = makeSnapshot();
    assert.ok(servingPrompt(snapshot).startsWith(SYSTEM_PROMPT));
    assert.equal(buildMessages(snapshot)[0]!.content, SYSTEM_PROMPT);
  });
});

describe('wire vocabulary', () => {
  it('writes FLAT as NONE and reads it back', () => {
    assert.equal(WIRE.FLAT, 'NONE');
    assert.equal(FROM_WIRE.NONE, 'FLAT');
  });

  it('round-trips every action', () => {
    for (const side of ['LONG', 'SHORT', 'FLAT'] as Side[]) {
      assert.equal(FROM_WIRE[WIRE[side]], side);
    }
  });

  it('never puts the word FLAT in front of the model', () => {
    // FLAT tokenises as FL+AT against single tokens for LONG and SHORT, which biases
    // greedy decoding against it before training starts.
    assert.ok(!SYSTEM_PROMPT.includes('FLAT'));
    assert.ok(!servingPrompt(makeSnapshot()).includes('FLAT'));
    assert.ok(!WIRE_WORDS.includes('FLAT' as never));
  });

  it('treats a reply of FLAT as a parse failure, not as FLAT', () => {
    assert.equal(parseAction('NONE'), 'FLAT');
    assert.equal(parseAction('FLAT'), null);
  });
});

describe('FLAT oversampling', () => {
  it('over-weights FLAT past parity', () => {
    // Measured on generation 1: a balanced 33.2% FLAT dataset produced 14% FLAT at
    // inference. Parity in equals well under parity out.
    assert.ok(CLASS_WEIGHT.FLAT > CLASS_WEIGHT.LONG);
    assert.equal(CLASS_WEIGHT.LONG, CLASS_WEIGHT.SHORT);
  });

  it('emits more NONE than LONG or SHORT when FLAT supply allows', () => {
    // Mirrors the real gen-0 distribution, where FLAT is the most common truth:
    // 354 FLAT against 179 LONG and 203 SHORT.
    const pairs: Array<[Side, Side]> = [];
    for (let i = 0; i < 60; i++) pairs.push(['LONG', 'FLAT']);
    for (let i = 0; i < 30; i++) pairs.push(['FLAT', 'LONG']);
    for (let i = 0; i < 30; i++) pairs.push(['FLAT', 'SHORT']);

    const counts: Record<string, number> = {};
    for (const e of buildCurriculum(makeTraces(pairs), { correctRatio: 0 })) {
      counts[e.output] = (counts[e.output] ?? 0) + 1;
    }

    assert.ok(
      counts.NONE! > counts.LONG!,
      `expected NONE oversampled, got ${JSON.stringify(counts)}`,
    );
    assert.equal(counts.LONG, counts.SHORT, 'directional classes stay at parity');
  });

  it('is a cap, not a quota: it cannot invent FLAT examples that do not exist', () => {
    // With equal supply there is nothing to oversample from, and the builder must not
    // duplicate rows to hit the weight.
    const pairs: Array<[Side, Side]> = [];
    for (let i = 0; i < 30; i++) pairs.push(['LONG', 'FLAT']);
    for (let i = 0; i < 30; i++) pairs.push(['FLAT', 'LONG']);
    for (let i = 0; i < 30; i++) pairs.push(['FLAT', 'SHORT']);

    const counts: Record<string, number> = {};
    for (const e of buildCurriculum(makeTraces(pairs), { correctRatio: 0 })) {
      counts[e.output] = (counts[e.output] ?? 0) + 1;
    }
    assert.deepEqual(counts, { LONG: 30, SHORT: 30, NONE: 30 });
  });
});

describe('prompt version', () => {
  it('is recorded so a prompt change cannot pass unnoticed on chain', async () => {
    const { computeConfigHash, DEFAULT_TRAINING_CONFIG } = await import(
      '../../lineage/src/hash.js'
    );
    const { DEFAULT_BACKTEST } = await import('../../../schemas/index.js');

    const input = {
      training: DEFAULT_TRAINING_CONFIG,
      backtest: DEFAULT_BACKTEST,
      baseModel: 'Qwen2.5-0.5B-Instruct',
    };
    const hash = computeConfigHash(input);

    assert.match(hash, /^0x[0-9a-f]{64}$/);
    assert.ok(PROMPT_VERSION >= 2, 'prompt version must advance past the generation-1 text');
  });
});
