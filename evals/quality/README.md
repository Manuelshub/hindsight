# Decision-quality evals

The suite in `test/` (and the 74 gate tests beside it) answers **is the code correct**.
This suite answers a different question — **is the brain any good** — and the two must not
be confused. Generation 1's code is correct. Generation 1 made 736 decisions, never once
said FLAT, and finished 20 points below what it would have scored by doing nothing. Every
gate test was green the whole time.

Anything implementing `DecideFn = (s: MarketSnapshot) => Promise<Decision>` can be run
through it: the deterministic baselines, generation 0 on 0G Compute, generation N's local
LoRA, or something that does not exist yet. Nothing downstream of `harness/brains.ts`
knows which one it got, which is the only reason comparing them proves anything.

---

## Run it

```bash
# every free brain on the held-out window — no network, no wallet, ~2 seconds
pnpm tsx evals/quality/cli.ts

# one brain, full report
pnpm tsx evals/quality/cli.ts --brain momentum

# the larger pre-training window
pnpm tsx evals/quality/cli.ts --window pre

# generation N's local adapter (needs serving/server.py on :8177 — free)
pnpm tsx evals/quality/cli.ts --brain adapter --generation 1

# generation 0 on 0G Compute. Billed. Refuses to start without --yes-spend.
pnpm tsx evals/quality/cli.ts --brain remote --max-decisions 120 --yes-spend

# the suite's own gate tests
pnpm tsx --test 'evals/quality/test/*.test.ts'

# typecheck (standalone: does not depend on the root tsconfig)
npx tsc --noEmit -p evals/quality/tsconfig.json
```

`--help` lists every flag.

---

## The verdict

A run fails loudly. Exit code is the whole interface, because a scheduled job sees a
number and nothing else.

| code | meaning | what to do |
|---|---|---|
| `0` | every gated check met its threshold | nothing |
| `1` | the brain produced decisions and at least one check failed | this is a result — publish it |
| `2` | bad arguments, unknown brain, or a paid run without consent | fix the command |
| `3` | the brain could not be reached, or stopped answering | check the service, retry |
| `4` | the held-out window overlaps training data, or is too small | rebuild the fixture |

`1` and `3` are split on purpose. "Your agent is bad" is a finding; "the adapter server
died" is an outage. A suite that reports both as red teaches its operators to ignore both.

The line is drawn at the `DecideFn` boundary and nowhere else:

- a call that **throws** is an outage. Isolated throws are tolerated and counted;
  `--fault-limit` consecutive throws (default 3) end the run as code `3`.
- a call that **returns** is an opinion, however bad. Unreadable and illegal answers are
  counted against the brain, never against the network.

Brain construction failing — no adapter server listening, no `PRIVATE_KEY` — is always
code `3`, because nothing was decided.

---

## The pass bar

Frozen in `harness/thresholds.ts`. These numbers were written before any brain was
measured against them.

| check | threshold | what it catches |
|---|---|---|
| `coverage` | least-used action ≥ **2%** of decisions | a brain that has silently dropped an action |
| `edge` | accuracy − always-FLAT accuracy ≥ **0** | a brain with negative information value |
| `parse` | parse-failure rate ≤ **2%** | an accuracy figure that is really measuring the parser |
| `skill` | Matthews correlation ≥ **0** | a brain that has learned the class prior and nothing else |
| `consistency` | identical-input agreement ≥ **95%** | a brain too noisy for generations to be compared at all |

A run also refuses to render a verdict on fewer than **100** scored decisions (code `4`).

`--thresholds <file>` overrides them for experiments. The report records which set was
used, so a relaxed run can never be mistaken for a passing one.

---

## What each metric means

### Action distribution

`counts`, `shares`, `entropy` (0 = one action forever, 1 = a perfectly even split), and
`minShare`, which is what the `coverage` check gates on.

**Why it matters.** This is the failure the project actually has. Across 1,472 real
decisions, generations 0 and 1 have emitted FLAT exactly zero times, on data where FLAT is
the correct answer 46% of the time. That is not a strategy — a third of the action space
is simply unreachable, and no amount of accuracy tuning will recover it. Accuracy cannot
see this. A brain stuck on LONG and a brain choosing LONG can score identically.

### Accuracy, and edge over always-FLAT

`accuracy` is the fraction matching the hindsight label — the figure the on-chain record
stores. `flatAccuracy` is what always-FLAT would have scored **on this exact window**,
recomputed every run rather than quoted from the README. `edge` is the difference, in
percentage points.

**Why it matters.** Doing nothing is the hardest baseline on this data. Recomputing it per
window is not pedantry: always-FLAT scores 47.14% on the forward window and 35.31% on the
pre-training one. A fixed 46.33% constant would have handed a brain a free 11-point edge
on one window and quietly taxed it on the other.

### Balanced accuracy and MCC

`balancedAccuracy` is mean per-class recall, averaged only over classes the market
actually produced — including an absent class would blame the brain for a quiet market.
`mcc` is the multiclass Matthews correlation.

**Why it matters.** Accuracy rewards guessing the majority class. MCC is **exactly 0** for
any constant predictor, so it separates real signal from prior-exploitation, and goes
negative for a brain that is reliably wrong. This is what makes `skill` gate-worthy where
accuracy is not: always-FLAT scores 47.14% accuracy and MCC 0.000, which is the honest
reading of it.

Per-class precision/recall/F1 and the full confusion matrix are printed too. That is where
you see *how* a brain is wrong: momentum on the forward window has 0% SHORT recall — it
never once caught a down move — while looking respectable on the headline number.

### Parse-failure rate

Fraction of answers the brain returned but could not be turned into an action.

**Why it matters.** An unreadable answer gets scored as FLAT, so a brain that hedges its
way through a run gets FLAT's 46% baseline for free and looks competent. Detection uses
the convention both shipped brains already follow — `confidence: 0` and a rationale
prefixed `unparseable:` — which makes it observable through the `Decision` contract alone.
The harness never reaches into a brain's private counters; it could not work against an
arbitrary `DecideFn` if it did.

Answers outside `LONG | SHORT | FLAT` are counted separately as `illegal action` and
scored as FLAT, so one malformed reply cannot abort a window.

### Consistency

A seeded sample of already-decided bars is re-presented `--repeats` times (default 24
probes × 3). `consistency` is the fraction of probes where every answer agreed with every
other **and** with the original. `modalAgreement` is the softer version. Disagreements are
printed with their timestamps.

**Why it matters.** This decides whether any other number can be believed. Generation 1
beat generation 0 by 2.17 accuracy points. If re-running generation 1 on identical inputs
moves it by more than that, the comparison measured sampling noise and the lineage claim
collapses.

**The nudge.** `renderSnapshot` reads the features and the close, never `at`, while
`snapshotHash` — the inference cache key — includes `at`. So the probe shifts `at` by a
millisecond: the brain sees a byte-identical prompt behind a fresh cache key. Without it
the probe would replay `runs/cache` and report a flawless 1.00 for a brain that is in fact
wildly unstable. `test/runner.test.ts` pins `renderSnapshot`'s indifference to `at` so the
trick cannot rot silently.

### Economics

Mean return, cumulative return, Sharpe, max drawdown — from `computeStats`, the same
function that produces the on-chain record.

**Reported, never gated.** This is not a profitability suite, and a 140-bar window with
overlapping horizons cannot support a tradeable Sharpe. They are here for context, and
because a brain whose accuracy and returns disagree is worth a second look.

---

## The held-out window

Invariant I2 says a generation may only be graded on bars it could not have seen. The
registry enforces that on-chain for sealed results. This suite runs constantly and
off-chain, so it enforces the same separation itself, from evidence rather than from good
intentions.

**1. The boundary is derived, not asserted.** `build-holdout.ts` reads every
`runs/gen-*/` directory and takes the union of what training touched:

- every trace's snapshot time, widened forward by `horizon` bars — a trace at bar `i` was
  labelled from the close of bar `i + horizon`, so the run saw further forward than its
  last snapshot time admits;
- widened backward by `WARMUP` bars, because its features read that far back;
- and the full candle range recorded in each `stats.json`, which is wider than either.

For this repository that resolves to `2026-04-12T17:00:00.000Z → 2026-08-15T16:59:59.999Z`,
recorded in `data/manifest.json` alongside the four files it came from.

**2. Every scored bar is re-checked, every run.** Both the decision bar **and** the bar its
label is read from must clear the boundary. Checking only the decision bar would let a bar
near the edge be graded against a close sitting inside the training window.

**3. The claim is falsifiable.** `runs/` is gitignored, so a frozen manifest alone would be
an assertion nobody could check. When `runs/` *is* present the boundary is re-derived live
and compared: if training data has moved past the frozen line, the run aborts with exit
code `4` and tells you to rebuild. Train a generation on newer bars and forget to rebuild,
and the suite refuses to grade it rather than grading it on its own training set.

### Two windows, and what each is worth

| window | bars | relation | evidential weight |
|---|---|---|---|
| `forward` *(default)* | 140 scoreable | after the newest training bar | **the real one.** Matches the on-chain seal. Grows by 24 bars a day. |
| `pre` | 1,144 scoreable | before the oldest training bar | diagnostic only — see the caveat |

The forward window is the one that means something and the one that is currently too
small. 140 decisions puts roughly ±8 points of sampling noise around an accuracy figure,
which is why momentum passes there and fails on `pre`. Report both; trust `forward`; wait
for it to grow.

The `pre` window is honestly held out from *this project's* training — no generation has
ever seen those bars — but the base model's own pretraining may well have covered
early 2026. Its numbers bound how much of the answer the model already knew, and are not
evidence of learning.

### What is deliberately *not* excluded

An `after` window's first bars read `WARMUP` bars of pre-boundary history to compute their
features. That is context, not leakage: the brain is being asked what happens next given
history it was always going to have. What it must never see is the answer, and the answer
lives entirely in bars past the boundary.

---

## Determinism, and where it stops

Deterministic, and asserted by the tests:

- the market data (a frozen fixture on disk — the eval never fetches anything),
- which bars are scored (boundary rule + `--stride` + even thinning under `--max-decisions`),
- which bars are re-probed (`--seed`, default 1337, through a mulberry32 PRNG),
- every metric, threshold and verdict,
- the three baselines and both controls.

Two runs against a baseline produce **byte-identical** JSON. `test/runner.test.ts` asserts
it, which is why the report carries no wall-clock or run-id fields.

Non-deterministic, irreducibly:

- token sampling inside `remote` and `adapter`. Both are run at `temperature: 0`, which
  reduces the variance without removing it.

That boundary is exactly what `consistency` measures, and it is the reason the check is
gated rather than merely reported.

One caveat worth stating plainly: the `remote` brain caches responses under `runs/cache`
by snapshot hash, so a **second** run of the same window is served from disk and its
consistency figure describes the cache. The probe's millisecond nudge defeats the cache on
the *first* run, which is the one that measures the model. Use `--no-cache` to re-measure
it from scratch, at full price.

---

## Cost

Free by default, and structurally so. `--brain` defaults to the five brains that make no
network calls and cost nothing; the market data is a committed fixture; `build-holdout.ts`
is the only thing here that touches the network, it is run separately, and Binance's
public mirror is free.

A paid brain prints its estimate and then refuses to run without `--yes-spend`:

```
  remote is billed: ~192 calls x 1 brain(s) ~= 0.0867 0G (cache hits are free)

refusing to spend without --yes-spend
```

`--max-decisions N` caps a paid run, thinned evenly across the window so a sampled run
still spans every regime in it rather than grading one week and calling it the period.

---

## Where it stands today

Real output, `pnpm tsx evals/quality/cli.ts`, 2026-08-21:

```
window "forward" — 546 candles, 140 held out
  scoring ~140 decisions per brain, seed 1337

=== summary ===
  brain            verdict  decisions  accuracy  vs-flat      MCC  minShare  parse  consist
  flat             FAIL          140    47.14%  +0.00pp    0.000     0.00%  0.00%  100.00%
  momentum         PASS          140    47.14%  +0.00pp    0.095     9.29%  0.00%  100.00%
  mean-reversion   FAIL          140    39.29%  -7.86pp    0.137     2.14%  0.00%  100.00%
  random           FAIL          140    32.14% -15.00pp   -0.028    30.71%  0.00%  100.00%
  oracle           PASS          140   100.00% +52.86pp    1.000     8.57%  0.00%  100.00%

flat: failed coverage
mean-reversion: failed edge
random: failed edge, skill

exit 1
```

And on the larger window, `--window pre`:

```
  brain            verdict  decisions  accuracy  vs-flat      MCC  minShare  parse  consist
  flat             FAIL         1144    35.31%  +0.00pp    0.000     0.00%  0.00%  100.00%
  momentum         FAIL         1144    33.65%  -1.66pp    0.003    31.38%  0.00%  100.00%
  mean-reversion   FAIL         1144    34.09%  -1.22pp   -0.009    12.67%  0.00%  100.00%
  random           FAIL         1144    33.48%  -1.84pp    0.002    33.22%  0.00%  100.00%
  oracle           PASS         1144   100.00% +64.69pp    1.000     32.26%  0.00%  100.00%

exit 1
```

Reading it:

- **`flat` fails on coverage alone** and on nothing else. That is the correct verdict on a
  brain that scores the highest accuracy in the table by refusing to have an opinion — and
  it is why coverage is a gate rather than a footnote.
- **`momentum` passing the forward window is a small-sample artifact**, and the suite says
  so by failing it on `pre` with 8× the decisions. Its confusion matrix shows 0% SHORT
  recall on both windows. Do not read that PASS as an endorsement; read it as the reason
  the forward window is labelled too small.
- **`random` fails `edge` and `skill` while passing `coverage`.** That is the whole point
  of the negative control: it uses all three actions perfectly evenly and has no skill
  whatsoever, which is exactly the brain coverage alone would have waved through.
- **`oracle` passes everything.** The positive control. An eval nobody can pass is
  indistinguishable from a broken one, and this is the proof the thresholds are reachable
  and the scoring path is wired to production's `scoreDecision`.
- **Neither live generation has been run through this yet.** Generation 1 needs
  `serving/server.py` up; generation 0 costs money. Both are one flag away. On their
  recorded numbers — zero FLAT across 1,472 decisions, both below always-FLAT — both will
  fail `coverage` and `edge`, and that failure is the honest headline result.

---

## Adding a brain

Add an entry to `BRAINS` in `harness/brains.ts`:

```ts
mine: {
  kind: 'baseline',            // baseline | control | service | paid
  describe: 'what it does',
  create: async (ctx) => myDecideFn,
},
```

`kind` drives spend and reachability policy only. It never reaches the metrics — if it
ever did, comparing a baseline to an adapter would stop proving anything.

---

## Layout

| path | what it is |
|---|---|
| `cli.ts` | entry point, argument parsing, exit codes, spend guard |
| `build-holdout.ts` | the only thing here that touches the network; cuts the frozen fixtures |
| `harness/project.ts` | the single seam to the application — one file to repoint when the repo moves |
| `harness/types.ts` | exit codes and the report contract |
| `harness/thresholds.ts` | the frozen pass bar, each number with its reason |
| `harness/holdout.ts` | boundary derivation and the separation guarantee |
| `harness/metrics.ts` | pure metric arithmetic — no I/O, no brain awareness |
| `harness/consistency.ts` | the repeat probe and its cache-defeating nudge |
| `harness/brains.ts` | the brain registry |
| `harness/run.ts` | the runner: outage-versus-quality classification, checks, verdict |
| `harness/report.ts` | human-readable rendering |
| `harness/rng.ts` | the seeded PRNG everything sampled goes through |
| `data/` | frozen candle fixtures and the provenance manifest |
| `test/` | 48 gate tests for the suite itself |
