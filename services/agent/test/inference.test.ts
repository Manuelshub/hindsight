/**
 * Specification for the generation-0 brain. Currently red.
 *
 * Strict parsing matters more than it looks: a model that rambles has not done the task,
 * and coercing that into FLAT would bury the failure inside a plausible accuracy number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages, parseAction, snapshotHash, toDecision } from '../src/inference.js';
import { makeSnapshot } from '../../../schemas/fixtures.js';

describe('parseAction — accepts genuine answers', () => {
  const accepted: Array<[string, string]> = [
    ['LONG', 'LONG'],
    ['SHORT', 'SHORT'],
    ['NONE', 'FLAT'],
    ['long', 'LONG'],
    ['  Short  ', 'SHORT'],
    ['NONE.', 'FLAT'],
    ['Answer: LONG', 'LONG'],
    ['**SHORT**', 'SHORT'],
  ];

  for (const [raw, expected] of accepted) {
    it(`parses ${JSON.stringify(raw)} as ${expected}`, () => {
      assert.equal(parseAction(raw), expected);
    });
  }
});

describe('parseAction — rejects non-answers', () => {
  const rejected = [
    // FLAT is off-vocabulary now. The model is instructed to answer NONE, so a reply of
    // FLAT means it ignored the instruction, and that should surface as a parse failure
    // rather than be quietly accepted.
    'FLAT',
    '',
    '   ',
    'I cannot provide financial advice.',
    'Maybe long, maybe short — it depends on your risk tolerance.',
    'BUY',
    'SELL',
    'HOLD',
    '42',
  ];

  for (const raw of rejected) {
    it(`returns null for ${JSON.stringify(raw)}`, () => {
      assert.equal(parseAction(raw), null);
    });
  }

  it('rejects a response naming more than one action', () => {
    assert.equal(parseAction('LONG or SHORT'), null);
  });
});

describe('snapshotHash — cache key stability', () => {
  it('is stable for identical snapshots', () => {
    assert.equal(snapshotHash(makeSnapshot()), snapshotHash(makeSnapshot()));
  });

  it('changes when any feature changes', () => {
    const base = makeSnapshot();
    const altered = makeSnapshot({ features: { ...base.features, rsi14: 71 } });
    assert.notEqual(snapshotHash(base), snapshotHash(altered));
  });

  it('changes when the bar time changes', () => {
    const base = makeSnapshot();
    assert.notEqual(snapshotHash(base), snapshotHash(makeSnapshot({ at: base.at + 3_600_000 })));
  });
});

describe('buildMessages', () => {
  it('sends a system instruction and the rendered snapshot', () => {
    const messages = buildMessages(makeSnapshot());
    assert.ok(messages.length >= 2);
    assert.equal(messages[0]!.role, 'system');
    assert.equal(messages.at(-1)!.role, 'user');
    assert.match(messages.at(-1)!.content, /rsi_14:/);
  });

  it('never leaks the future into the prompt', () => {
    const content = buildMessages(makeSnapshot())
      .map((m) => m.content)
      .join('\n');
    for (const forbidden of ['forwardReturn', 'hindsight', 'realizedReturn', 'correct']) {
      assert.ok(!content.includes(forbidden), `prompt leaked ${forbidden}`);
    }
  });
});

describe('toDecision', () => {
  it('carries generation and model through', () => {
    const decision = toDecision('LONG', 'LONG', 3, 'gen3-lora');
    assert.equal(decision.action, 'LONG');
    assert.equal(decision.generation, 3);
    assert.equal(decision.model, 'gen3-lora');
  });


  it('produces a confidence within [0,1]', () => {
    const decision = toDecision('SHORT', 'SHORT', 0, 'qwen');
    assert.ok(decision.confidence >= 0 && decision.confidence <= 1);
  });
});
