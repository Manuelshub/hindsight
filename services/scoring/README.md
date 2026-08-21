# services/scoring

Scores decisions against what the market actually did, and compares generations.

## Contract

- `runBacktest(candles, decide, cfg)` -> `Trace[]`
- `scoreDecision(candles, i, action, cfg)` -> `Outcome`
- `computeStats(traces, cfg)` -> `GenerationStats`
- `assertSealedWindow(sealedAt, windowStart)` - throws on an unsealed window

## Hindsight labelling

    forwardReturn = log(close[i+horizon] / close[i])
    correct       = LONG  if forwardReturn >  flatThreshold
                    SHORT if forwardReturn < -flatThreshold
                    FLAT  otherwise

`flatThreshold` stops the agent being trained to chase moves smaller than its own costs,
which is a reliable way to manufacture in-sample skill that vanishes live.

Every non-FLAT decision pays `costPerTrade`. There are no costless backtests here.

## Sealed vs replay

A sealed evaluation runs only on bars that closed at or after the generation's on-chain
seal. It is the only kind that may be reported as evidence of improvement. A replay
evaluation runs on historical data for development speed and is labelled unsealed
everywhere it appears.

`assertSealedWindow` throws rather than returning a boolean. A caller who forgets to check
a flag would publish an unsealed number as sealed, and by the time the contract reverts,
the figure is already in a report.

## Test

    pnpm tsx --test services/scoring/test/*.test.ts
