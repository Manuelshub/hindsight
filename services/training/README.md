# services/training

The fine-tuning state machine.

## Contract

- `nextState(state, event)` -> `TaskState`, throws on an illegal transition
- `hoursUntilForfeit(deliveredAt, now)` -> hours, negative once the window closed
- `needsUrgentAcknowledgement(record, now)` -> boolean
- `loadTaskRecord` / `saveTaskRecord` / `transition`

    PENDING -> FUNDED -> SUBMITTED -> TRAINING -> DELIVERED
            -> ACKNOWLEDGED -> DECRYPTED -> SEALED
    plus terminal FAILED and FORFEITED

## Why this is a state machine and not a script

The platform makes it one. There is a single fine-tuning provider network-wide that takes
one task at a time, delivery is known to hang, and a delivered adapter is forfeited along
with 30% of the fee if it is not acknowledged within 48 hours.

Illegal transitions throw rather than no-op, so a polling bug surfaces immediately instead
of stalling a job that has already been paid for.

The watchdog raises the alarm at 24 hours remaining, not 47. Acknowledgement itself can
fail and a retry needs room.

## Funding trap

The broker sweeps the entire ledger balance into whichever provider sub-account you touch
first. After an inference run, `getLedger()` still reports the full balance while
`transferFund` fails with `InsufficientAvailableBalance` and zero available. Budget per
service, not per ledger. Funding is idempotent for this reason.

## Test

    pnpm tsx --test services/training/test/*.test.ts
