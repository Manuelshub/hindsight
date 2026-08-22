/**
 * Metric arithmetic. Every case here is one the eval's verdict turns on, so a hand-checked
 * fixture beats a property test: if MCC drifts, a brain with no skill starts passing and
 * nothing else in the suite notices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Outcome, Side } from '../src/project.js';
import {
  accuracyMetrics,
  actionDistribution,
  isParseFailure,
  isSide,
  malformedReason,
  mcc,
  mcnemarP,
  neutralise,
} from '../src/metrics.js';

function outcomes(hindsight: Side[]): Outcome[] {
  return hindsight.map((h) => ({
    forwardReturn: 0,
    realizedReturn: 0,
    hindsight: h,
    correct: false,
  }));
}

describe('actionDistribution', () => {
  it('reports a share of zero for an action that never appears', () => {
    const d = actionDistribution(['LONG', 'LONG', 'SHORT']);
    assert.equal(d.counts.FLAT, 0);
    assert.equal(d.shares.FLAT, 0);
    assert.equal(d.minShare, 0);
    assert.equal(d.used, 2);
  });

  it('scores a perfectly even split as maximum entropy', () => {
    const d = actionDistribution(['LONG', 'SHORT', 'FLAT']);
    assert.ok(Math.abs(d.entropy - 1) < 1e-12);
    assert.equal(d.used, 3);
  });

  it('scores a single-action brain as zero entropy', () => {
    const d = actionDistribution(['FLAT', 'FLAT', 'FLAT']);
    assert.equal(d.entropy, 0);
  });

  it('handles an empty run without dividing by zero', () => {
    const d = actionDistribution([]);
    assert.equal(d.entropy, 0);
    assert.equal(d.minShare, 0);
  });
});

describe('mcc', () => {
  const zero = { LONG: 0, SHORT: 0, FLAT: 0 };

  it('is exactly 0 for a constant predictor — the reason it gates and accuracy does not', () => {
    const said: Side[] = Array.from({ length: 100 }, () => 'FLAT');
    const truth: Side[] = [
      ...Array.from({ length: 46 }, (): Side => 'FLAT'),
      ...Array.from({ length: 30 }, (): Side => 'LONG'),
      ...Array.from({ length: 24 }, (): Side => 'SHORT'),
    ];
    const metrics = accuracyMetrics(said, outcomes(truth));

    assert.equal(metrics.accuracy, 0.46);
    assert.equal(metrics.mcc, 0);
  });

  it('is 1 for a perfect predictor', () => {
    const truth: Side[] = ['LONG', 'SHORT', 'FLAT', 'LONG', 'SHORT', 'FLAT'];
    assert.ok(Math.abs(accuracyMetrics(truth, outcomes(truth)).mcc - 1) < 1e-12);
  });

  it('goes negative when the brain is reliably wrong', () => {
    const truth: Side[] = ['LONG', 'LONG', 'SHORT', 'SHORT'];
    const said: Side[] = ['SHORT', 'SHORT', 'LONG', 'LONG'];
    assert.ok(accuracyMetrics(said, outcomes(truth)).mcc < 0);
  });

  it('returns 0 rather than NaN when nothing was decided', () => {
    assert.equal(mcc({ LONG: { ...zero }, SHORT: { ...zero }, FLAT: { ...zero } }), 0);
  });
});

/**
 * The test that stops "+2.17pp, therefore it improved" being said on a window where 2.17pp
 * is a coin flip. Everything else in the suite reports an effect; this reports whether the
 * window was ever capable of showing one.
 */
describe('mcnemarP', () => {
  it('returns 1 when the brain and always-FLAT never disagree', () => {
    assert.equal(mcnemarP(0, 0), 1);
  });

  it('returns 1 when the disagreements split evenly', () => {
    assert.equal(mcnemarP(40, 40), 1);
  });

  it('cannot reach significance on a small lopsided sample', () => {
    // 8 versus 2: a 6-bar lead, which is what a 4pp edge looks like on 140 bars.
    assert.ok(mcnemarP(8, 2) > 0.05);
  });

  it('reaches significance once the same imbalance is measured on enough bars', () => {
    assert.ok(mcnemarP(80, 20) < 0.05);
  });

  it('is symmetric — a brain reliably worse than the control is just as detectable', () => {
    assert.equal(mcnemarP(80, 20), mcnemarP(20, 80));
  });

  it('approximates the textbook value closely enough to gate on', () => {
    // b=25, c=10: chi-square with continuity correction = (15-1)^2/35 = 5.6, p ~= 0.018.
    assert.ok(Math.abs(mcnemarP(25, 10) - 0.018) < 0.002);
  });
});

describe('accuracyMetrics', () => {
  it('measures always-FLAT on the same window rather than a stored constant', () => {
    const truth: Side[] = ['FLAT', 'FLAT', 'LONG', 'SHORT'];
    const metrics = accuracyMetrics(['LONG', 'LONG', 'LONG', 'LONG'], outcomes(truth));

    assert.equal(metrics.flatAccuracy, 0.5);
    assert.equal(metrics.accuracy, 0.25);
    assert.equal(metrics.edgeOverFlat, -0.25);
  });

  it('averages recall only over classes the market actually produced', () => {
    const truth: Side[] = ['LONG', 'LONG', 'FLAT', 'FLAT'];
    const metrics = accuracyMetrics(['LONG', 'LONG', 'FLAT', 'LONG'], outcomes(truth));

    // SHORT never occurred, so including its zero recall would blame the brain for the market.
    assert.equal(metrics.perClass.SHORT.support, 0);
    assert.ok(Math.abs(metrics.balancedAccuracy - 0.75) < 1e-12);
  });

  it('orients the confusion matrix as [truth][said]', () => {
    const metrics = accuracyMetrics(['SHORT'], outcomes(['LONG']));
    assert.equal(metrics.confusion.LONG.SHORT, 1);
    assert.equal(metrics.confusion.SHORT.LONG, 0);
  });

  /** What the coverage gate needs in order to tell brain scarcity from market scarcity. */
  it('reports what the market itself paid out, alongside what the brain played', () => {
    const truth: Side[] = ['FLAT', 'FLAT', 'FLAT', 'LONG'];
    const metrics = accuracyMetrics(['LONG', 'LONG', 'LONG', 'LONG'], outcomes(truth));

    assert.equal(metrics.marketShares.FLAT, 0.75);
    assert.equal(metrics.marketShares.LONG, 0.25);
    assert.equal(metrics.marketShares.SHORT, 0);
  });

  it('counts only the bars where exactly one of the two was right', () => {
    // FLAT correct on bars 1 and 2; brain says LONG throughout, right only on bar 4.
    const truth: Side[] = ['FLAT', 'FLAT', 'SHORT', 'LONG'];
    const metrics = accuracyMetrics(['LONG', 'LONG', 'LONG', 'LONG'], outcomes(truth));
    assert.equal(metrics.discordant, 3);
  });
});

/**
 * The `Decision` contract, enforced in full.
 *
 * A brain that returns `confidence: 7` is as broken as one that returns `action: "BUY"`,
 * and letting the first through means the confidence field is decorative. None of these
 * may throw: the value has crossed a `DecideFn` boundary and a bug on the far side must
 * never surface as an operator error.
 */
describe('malformedReason', () => {
  const valid = {
    action: 'LONG' as Side,
    confidence: 0.5,
    rationale: 'because',
    generation: 1,
    model: 'stub',
  };

  it('accepts a well-formed decision', () => {
    assert.equal(malformedReason(valid), undefined);
  });

  it('rejects null without dereferencing it', () => {
    assert.match(malformedReason(null) ?? '', /null/);
  });

  for (const [label, value] of [
    ['undefined', undefined],
    ['a string', 'LONG'],
    ['a number', 7],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.ok(malformedReason(value) !== undefined);
    });
  }

  it('rejects an action outside Side', () => {
    assert.match(malformedReason({ ...valid, action: 'BUY' }) ?? '', /not a Side/);
  });

  it('rejects a confidence above 1', () => {
    assert.match(malformedReason({ ...valid, confidence: 7 }) ?? '', /outside 0\.\.1/);
  });

  it('rejects a confidence below 0', () => {
    assert.match(malformedReason({ ...valid, confidence: -0.1 }) ?? '', /outside 0\.\.1/);
  });

  it('rejects a NaN confidence', () => {
    assert.match(malformedReason({ ...valid, confidence: NaN }) ?? '', /not a finite number/);
  });

  it('rejects a non-string rationale', () => {
    assert.match(malformedReason({ ...valid, rationale: 42 }) ?? '', /rationale/);
  });

  it('rejects an empty model', () => {
    assert.match(malformedReason({ ...valid, model: '' }) ?? '', /model is empty/);
  });
});

describe('neutralise', () => {
  it('turns any malformed return into a FLAT that can neither earn nor lose', () => {
    const d = neutralise(null, 'decision was null, not an object');
    assert.equal(d.action, 'FLAT');
    assert.equal(d.confidence, 0);
    assert.match(d.rationale, /^malformed: /);
  });

  it('keeps a usable model label so the report still names the brain', () => {
    assert.equal(neutralise({ model: 'gen3-lora' }, 'action undefined is not a Side').model, 'gen3-lora');
  });
});

describe('parse-failure detection', () => {
  const base = { action: 'FLAT' as Side, generation: 0, model: 'm' };

  it('recognises the convention both shipped brains use', () => {
    assert.ok(isParseFailure({ ...base, confidence: 0, rationale: 'unparseable: LONG or SHORT' }));
  });

  it('does not mistake a confident FLAT for a failure', () => {
    assert.equal(isParseFailure({ ...base, confidence: 1, rationale: 'FLAT' }), false);
  });

  it('does not mistake a zero-confidence but readable answer for a failure', () => {
    assert.equal(isParseFailure({ ...base, confidence: 0, rationale: 'no view' }), false);
  });

  /** Fails safe: undercounting parse failures flatters the brain, which is the wrong way to be wrong. */
  it('still counts an unparseable answer the brain claims to be confident about', () => {
    assert.ok(isParseFailure({ ...base, confidence: 0.9, rationale: 'unparseable: ???' }));
  });
});

describe('isSide', () => {
  it('rejects anything outside the three legal actions', () => {
    assert.ok(isSide('LONG'));
    assert.equal(isSide('BUY'), false);
    assert.equal(isSide(undefined), false);
  });
});
