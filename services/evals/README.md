# services/evals

Measures whether a brain's decisions are any good. Distinct from the gate tests in
`services/*/test/`, which measure whether the code is correct. Code can be perfect and the
brain still worthless, which is exactly what happened to generation 1.

## Run it

    pnpm eval                          # all shipped brains, free, offline
    pnpm eval --brain momentum,oracle  # a subset
    pnpm eval --window pre             # the larger window
    pnpm eval --brain adapter --generation 2   # a served LoRA on :8177
    pnpm eval --brain inference --allow-paid   # generation 0, costs 0G

    pnpm tsx --test 'services/evals/test/*.test.ts'
    npx tsc --noEmit -p services/evals/tsconfig.json

## Exit codes

They are the product. Automation reads them, so they distinguish causes rather than
reporting one failure.

| code | meaning |
|---|---|
| 0 | every brain met the bar |
| 1 | a brain missed the bar. This is the only code that says anything about quality |
| 2 | usage: unknown flag, non-numeric argument, paid brain without `--allow-paid` |
| 3 | the service is down. Says nothing about the brain |
| 4 | the held-out window is untrustworthy and no verdict was rendered |

A brain returning garbage is code 1, never code 2. A brain bug reported as a user error
sends the reader to the wrong file.

## The metrics, and why each one is here

**coverage** — every action appears in at least 2% of decisions. Catches the failure both
live generations have: 736 decisions each, not one FLAT, on a window where FLAT is correct
46% of the time. A brain that dropped a third of its action space is not choosing, it is
stuck. Demoted to a warning when the market itself paid that action out less often than the
threshold, because then it measures the regime rather than the brain.

**edge over always-FLAT** — accuracy must at least match doing nothing, computed on the
same bars in the same run. Never hardcoded: always-FLAT scores 46.33% on the training
window and 33.80% on a held-out earlier one, so a fixed comparator would fail every brain
by twelve points of nothing.

**economics** — the same bar in money, and not redundant with it. Accuracy and profit come
apart here. Mean-reversion clears the accuracy gate by +0.21% and ends the window down
70.36%, because it pays `costPerTrade` on every non-FLAT bar. Always-FLAT earns exactly
zero, so a brain that cannot clear zero bought its accuracy with money it did not have.

**parse failures** — above 2% unreadable answers, the accuracy figure is measuring the
parser rather than the brain.

**malformed decisions** — zero tolerance. An unparseable answer is a model fumbling a
question. A return that is not a `Decision` (null, an action outside `Side`, a confidence
outside 0..1) is a broken integration, and averaging one into a hit rate produces a number
about nothing.

**thrown-call rate** — a dropped call is not a neutral sample. It is disproportionately the
hard ones: long prompts, rate-limited stretches. Past 2% the survivors are a biased
subsample and every metric downstream inherits the bias, so the verdict is withdrawn rather
than computed.

**Matthews correlation** — a single number that survives class imbalance, unlike accuracy.
Zero is chance.

**McNemar significance** — a paired test against always-FLAT on the same bars. The
`forward` window holds 140 decisions with a noise floor around ±8pp, which is wider than
most real edges. Without this a brain passes on sampling luck, and the README would have to
explain that the exit code is wrong.

**identical-input agreement** — the same snapshot asked twice must produce the same answer.
Below 95% nothing else in the report means anything, because the measurement is not
repeatable.

### INCONCLUSIVE

A brain that clears every gate on too few decisions is reported `INCONCLUSIVE`, not `PASS`,
with the number of decisions needed to certify. Shipping `momentum PASS` on 140 bars while
the documentation explains it is a sampling artifact puts the contradiction in the exit
code, where automation cannot see the caveat.

## The controls ship with the suite

An eval nobody can pass is indistinguishable from a broken one, so the proof is in the
output of every run rather than asserted in a document.

- **oracle** reads the label. Proves the bar is reachable.
- **random** passes coverage and fails skill. Proves coverage alone was never enough to gate on.
- **broken** returns garbage. Proves the contract check and the malformed gate fire.

## Held-out guarantee

The window must not overlap anything the agent has seen. `runs/` and `data/cache/` are
gitignored, so a manifest pinned inside the holdout file would certify itself on a fresh
clone. Instead the boundary is re-derived from `runs/gen-*/` on every run when those
directories exist: trace times widened forward by `horizon` and back by `WARMUP`, plus each
`stats.json` candle range. A mismatch against the frozen manifest aborts with exit 4 rather
than grading. Both the decision bar and its label bar must clear the boundary.

## Determinism

Seeded and deterministic against the baselines: two runs produce byte-identical JSON. Only
the LLM-backed brains (`inference`, `adapter`) are non-deterministic, and that is what
identical-input agreement measures.

**One constraint to know about.** The consistency probe shifts `at` by one millisecond to
get a byte-identical prompt behind a fresh cache key, so it measures the model rather than
the response cache. `renderSnapshot` ignores `at` and a test pins that. A brain deriving a
feature from `at` (hour of day, trading session) would be scored inconsistent by this probe.
No shipped brain does.
