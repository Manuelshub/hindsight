/**
 * Specification for the curriculum builder. Currently red — buildCurriculum is a stub.
 *
 * These tests encode the two rules that are easy to get wrong and expensive to discover
 * late: mistakes alone teach an inverse bias, and an unbalanced set collapses the model
 * into always-FLAT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CURRICULUM,
  INSTRUCTION,
  buildCurriculum,
  estimateCostOG,
  estimateTokens,
  serializeCurriculum,
} from '../src/curriculum.js';
import { makeMistakes, makeTraces } from '../../../schemas/fixtures.js';

describe('buildCurriculum — learning signal', () => {
  it('labels every example with the hindsight answer, never what the model said', () => {
    const traces = makeTraces([
      ['LONG', 'SHORT'],
      ['FLAT', 'LONG'],
      ['SHORT', 'FLAT'],
    ]);

    const examples = buildCurriculum(traces, { balanceClasses: false, correctRatio: 0 });

    assert.equal(examples.length, 3);
    for (const [i, example] of examples.entries()) {
      assert.equal(example.output, traces[i]!.outcome.hindsight);
      assert.notEqual(example.output, traces[i]!.decision.action);
    }
  });

  it('uses the shared instruction on every example', () => {
    const examples = buildCurriculum(makeMistakes(9), { balanceClasses: false });
    for (const example of examples) assert.equal(example.instruction, INSTRUCTION);
  });

  it('includes the rendered snapshot as input', () => {
    const examples = buildCurriculum(makeMistakes(3), { balanceClasses: false });
    for (const example of examples) {
      assert.match(example.input, /rsi_14:/);
      assert.match(example.input, /close:/);
    }
  });
});

describe('buildCurriculum — mistake selection', () => {
  it('keeps every mistake when correctRatio is 0', () => {
    const traces = [...makeMistakes(6), ...makeTraces([['LONG', 'LONG'], ['FLAT', 'FLAT']])];
    const examples = buildCurriculum(traces, { correctRatio: 0, balanceClasses: false });
    assert.equal(examples.length, 6);
  });

  it('mixes in correct examples at the requested ratio', () => {
    // 6 mistakes + 6 correct available, ratio 1 => expect 12
    const traces = [
      ...makeMistakes(6),
      ...makeTraces([
        ['LONG', 'LONG'],
        ['LONG', 'LONG'],
        ['SHORT', 'SHORT'],
        ['SHORT', 'SHORT'],
        ['FLAT', 'FLAT'],
        ['FLAT', 'FLAT'],
      ]),
    ];
    const examples = buildCurriculum(traces, { correctRatio: 1, balanceClasses: false });
    assert.equal(examples.length, 12);
  });

  it('never emits an empty set when mistakes exist', () => {
    const examples = buildCurriculum(makeMistakes(3));
    assert.ok(examples.length > 0);
  });
});

describe('buildCurriculum — class balance', () => {
  it('caps every class to the smallest when balancing is on', () => {
    // 10 traces whose truth is LONG, 2 SHORT, 1 FLAT
    const pairs: Array<[import('../../../schemas/index.js').Side, import('../../../schemas/index.js').Side]> = [
      ...Array(10).fill(['FLAT', 'LONG'] as const),
      ...Array(2).fill(['FLAT', 'SHORT'] as const),
      ['LONG', 'FLAT'] as const,
    ];
    const examples = buildCurriculum(makeTraces(pairs), {
      balanceClasses: true,
      correctRatio: 0,
    });

    const counts = examples.reduce<Record<string, number>>((acc, e) => {
      acc[e.output] = (acc[e.output] ?? 0) + 1;
      return acc;
    }, {});

    const values = Object.values(counts);
    assert.ok(values.length > 0);
    assert.equal(Math.max(...values), Math.min(...values), 'classes are not balanced');
  });
});

describe('buildCurriculum — token budget', () => {
  it('never exceeds maxTokens', () => {
    const examples = buildCurriculum(makeMistakes(600), { maxTokens: 2_000 });
    assert.ok(
      estimateTokens(examples) <= 2_000,
      `budget exceeded: ${estimateTokens(examples)} > 2000`,
    );
  });

  it('returns everything when the budget is generous', () => {
    const traces = makeMistakes(12);
    const examples = buildCurriculum(traces, {
      maxTokens: 10_000_000,
      balanceClasses: false,
      correctRatio: 0,
    });
    assert.equal(examples.length, 12);
  });
});

describe('I4 — determinism', () => {
  it('produces byte-identical JSONL across runs', () => {
    const traces = makeMistakes(40);
    const a = serializeCurriculum(buildCurriculum(traces));
    const b = serializeCurriculum(buildCurriculum(traces));
    assert.equal(a, b);
  });

  it('is insensitive to input ordering', () => {
    const traces = makeMistakes(30);
    const shuffled = [...traces].reverse();
    assert.equal(
      serializeCurriculum(buildCurriculum(traces)),
      serializeCurriculum(buildCurriculum(shuffled)),
    );
  });

  it('emits one valid JSON object per line', () => {
    const jsonl = serializeCurriculum(buildCurriculum(makeMistakes(9)));
    const lines = jsonl.trim().split('\n');
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(['instruction', 'input', 'output'].every((k) => k in parsed));
      assert.ok(['LONG', 'SHORT', 'FLAT'].includes(parsed.output));
    }
  });
});

describe('cost projection', () => {
  it('scales with epochs and token count', () => {
    const examples = buildCurriculum(makeMistakes(30), { balanceClasses: false });
    const one = estimateCostOG(examples, 1, 8e-7);
    const three = estimateCostOG(examples, 3, 8e-7);
    assert.ok(three > one);
  });

  it('matches the measured on-network rate within tolerance', () => {
    // 20k tokens x 3 epochs x 8e-7 = 0.048, plus ~0.01 storage reserve
    const examples = buildCurriculum(makeMistakes(400), { maxTokens: 20_000 });
    const cost = estimateCostOG(examples, 3, 8e-7);
    assert.ok(cost > 0.03 && cost < 0.08, `unexpected projection: ${cost}`);
  });
});

describe('defaults', () => {
  it('ships a sane default configuration', () => {
    assert.equal(DEFAULT_CURRICULUM.balanceClasses, true);
    assert.ok(DEFAULT_CURRICULUM.maxTokens > 0);
    assert.ok(DEFAULT_CURRICULUM.correctRatio >= 0);
  });
});
