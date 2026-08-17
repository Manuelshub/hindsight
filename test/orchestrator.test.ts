/**
 * Specification for the fine-tuning state machine. Currently red.
 *
 * The 48-hour forfeit window is the expensive one: miss it and the adapter is gone along
 * with 30% of the fee. These tests pin that behaviour before a single token is spent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORFEIT_WINDOW_HOURS,
  type TaskRecord,
  hoursUntilForfeit,
  isTerminal,
  needsUrgentAcknowledgement,
  nextState,
} from '../src/training/orchestrator.js';

const HOUR = 3_600_000;

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    generation: 1,
    state: 'DELIVERED',
    provider: '0xA02b95Aa6886b1116C4f334eDe00381511E31A09',
    datasetPath: 'runs/1/dataset.jsonl',
    updatedAt: 0,
    ...overrides,
  };
}

describe('state machine — happy path', () => {
  it('walks PENDING through to SEALED', () => {
    let state = nextState('PENDING', 'FUND_CONFIRMED');
    assert.equal(state, 'FUNDED');
    state = nextState(state, 'TASK_CREATED');
    assert.equal(state, 'SUBMITTED');
    state = nextState(state, 'TRAINING_STARTED');
    assert.equal(state, 'TRAINING');
    state = nextState(state, 'DELIVERY_OBSERVED');
    assert.equal(state, 'DELIVERED');
    state = nextState(state, 'ACKNOWLEDGED');
    assert.equal(state, 'ACKNOWLEDGED');
    state = nextState(state, 'DECRYPTED');
    assert.equal(state, 'DECRYPTED');
    state = nextState(state, 'SEAL_CONFIRMED');
    assert.equal(state, 'SEALED');
  });
});

describe('state machine — illegal transitions', () => {
  it('throws rather than silently ignoring an impossible event', () => {
    assert.throws(() => nextState('PENDING', 'SEAL_CONFIRMED'));
    assert.throws(() => nextState('TRAINING', 'FUND_CONFIRMED'));
    assert.throws(() => nextState('SEALED', 'TASK_CREATED'));
  });

  it('routes ERROR to FAILED from any live state', () => {
    for (const state of ['PENDING', 'FUNDED', 'SUBMITTED', 'TRAINING', 'DELIVERED'] as const) {
      assert.equal(nextState(state, 'ERROR'), 'FAILED');
    }
  });

  it('routes an expired window to FORFEITED', () => {
    assert.equal(nextState('DELIVERED', 'WINDOW_EXPIRED'), 'FORFEITED');
  });
});

describe('terminal states', () => {
  it('treats SEALED, FAILED and FORFEITED as terminal', () => {
    assert.equal(isTerminal('SEALED'), true);
    assert.equal(isTerminal('FAILED'), true);
    assert.equal(isTerminal('FORFEITED'), true);
  });

  it('treats every in-flight state as non-terminal', () => {
    for (const state of ['PENDING', 'FUNDED', 'SUBMITTED', 'TRAINING', 'DELIVERED'] as const) {
      assert.equal(isTerminal(state), false);
    }
  });
});

describe('48-hour forfeit window', () => {
  it('reports the full window immediately on delivery', () => {
    const delivered = 1_700_000_000_000;
    assert.equal(hoursUntilForfeit(delivered, delivered), FORFEIT_WINDOW_HOURS);
  });

  it('counts down as time passes', () => {
    const delivered = 1_700_000_000_000;
    assert.equal(hoursUntilForfeit(delivered, delivered + 10 * HOUR), FORFEIT_WINDOW_HOURS - 10);
  });

  it('goes negative once the window has closed', () => {
    const delivered = 1_700_000_000_000;
    assert.ok(hoursUntilForfeit(delivered, delivered + 49 * HOUR) < 0);
  });

  it('flags urgency well before expiry, not after', () => {
    const delivered = 1_700_000_000_000;
    assert.equal(needsUrgentAcknowledgement(record({ deliveredAt: delivered }), delivered), false);
    assert.equal(
      needsUrgentAcknowledgement(record({ deliveredAt: delivered }), delivered + 30 * HOUR),
      true,
      'watchdog should raise the alarm with hours to spare',
    );
  });

  it('ignores tasks that are not awaiting acknowledgement', () => {
    const delivered = 1_700_000_000_000;
    assert.equal(
      needsUrgentAcknowledgement(
        record({ state: 'ACKNOWLEDGED', deliveredAt: delivered }),
        delivered + 47 * HOUR,
      ),
      false,
    );
  });
});
