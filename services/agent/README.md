# services/agent

The brains, plus the curriculum that produces the next one.

## Contract

Every brain satisfies `DecideFn = (snapshot: MarketSnapshot) => Promise<Decision>`, so the
scoring harness cannot tell them apart. That is what makes cross-generation comparison a
comparison of agents rather than of two different pipelines.

- `baseline.ts` - `flat`, `momentum`, `meanReversion`. Deterministic, free, the controls.
- `inference.ts` - generation 0 via 0G Compute. Rate-limited to 9 req/min, response-cached
  by snapshot hash, TEE-verified.
- `adapter.ts` - generations 1+ via the local LoRA server on port 8177. Free, no limits.
- `curriculum.ts` - traces -> training JSONL.

## Two rules in the curriculum that look wrong and are not

Training only on mistakes teaches the inverse bias: the model learns "whatever I would
have said, say the opposite". Correct examples are mixed in at `correctRatio`.

FLAT is the right answer about 48% of the time. Left unbalanced, the model collapses to
always-FLAT, scores 46% accuracy, and has learned nothing. Classes are capped to the
smallest.

Deduplication defaults to off. On the dataset sizes the token budget allows, collapsing
near-identical examples can silently shrink the set below useful size.

## Parsing is strict on purpose

`parseAction` returns null for "BUY", "HOLD", and "LONG or SHORT". A model naming two
actions has refused to decide. Coercing that to FLAT would bury the failure inside a
plausible accuracy number, so it is counted as a parse failure and reported.

## Test

    pnpm tsx --test services/agent/test/*.test.ts
