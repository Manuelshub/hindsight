/**
 * Specification for sealed evaluation. Currently red.
 *
 * This mirrors the contract's `EvaluationPredatesSeal` on the client side. Publishing an
 * unsealed number as sealed is the one failure this project cannot recover from, so the
 * guard throws rather than returning a boolean a caller might forget to check.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertSealedWindow, toBps } from '../src/eval/compare.js';

const SEALED_AT = 1_700_000_000;

describe('assertSealedWindow — I2', () => {
  it('accepts a window starting after the seal', () => {
    assert.doesNotThrow(() => assertSealedWindow(SEALED_AT, SEALED_AT + 3600));
  });

  it('accepts a window starting exactly at the seal', () => {
    assert.doesNotThrow(() => assertSealedWindow(SEALED_AT, SEALED_AT));
  });

  it('rejects a window starting one second before the seal', () => {
    assert.throws(() => assertSealedWindow(SEALED_AT, SEALED_AT - 1));
  });

  it('rejects any pre-seal window', () => {
    for (const offset of [1, 60, 3600, 86_400, SEALED_AT - 1]) {
      assert.throws(
        () => assertSealedWindow(SEALED_AT, SEALED_AT - offset),
        `a window ${offset}s before the seal was accepted`,
      );
    }
  });
});

describe('toBps', () => {
  it('converts fractions to basis points', () => {
    assert.equal(toBps(0.4633), 4633);
    assert.equal(toBps(0), 0);
    assert.equal(toBps(1), 10_000);
  });

  it('handles negative returns', () => {
    assert.equal(toBps(-0.0987), -987);
  });

  it('returns an integer for on-chain storage', () => {
    assert.ok(Number.isInteger(toBps(0.123456)));
  });
});
