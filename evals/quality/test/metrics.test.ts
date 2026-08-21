/**
 * Metric arithmetic. Every case here is one the eval's verdict turns on, so a hand-checked
 * fixture beats a property test: if MCC drifts, a brain with no skill starts passing and
 * nothing else in the suite notices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Outcome, Side } from '../harness/project.js';
import {
  accuracyMetrics,
  actionDistribution,
  isParseFailure,
  isSide,
  mcc,
} from '../harness/metrics.js';

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
});

describe('isSide', () => {
  it('rejects anything outside the three legal actions', () => {
    assert.ok(isSide('LONG'));
    assert.equal(isSide('BUY'), false);
    assert.equal(isSide(undefined), false);
  });
});
