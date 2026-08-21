# services/market

Turns raw candles into the only thing the agent is allowed to see.

## Contract

- `getCandles({symbol, interval, limit})` -> `Candle[]`, ascending by time, disk-cached
- `buildSnapshot(candles, i, symbol, interval)` -> `MarketSnapshot`
- `renderSnapshot(snapshot)` -> the exact prompt text a brain receives

## The invariant this service exists to hold

`buildSnapshot(candles, i)` reads only `candles[0..i]`. Nothing later can influence it.
A look-ahead bug produces excellent results and is invisible in every metric, so the
boundary is structural rather than a convention. It is proved mechanically in
`services/scoring/test/invariants.test.ts`, which mutates every future bar and asserts the
snapshot is byte-identical.

`FEATURE_VERSION` and `RENDERER_VERSION` are recorded in the on-chain commitment. Change
either and earlier generations stop being comparable, so a bump starts a fresh lineage.

## Test

    pnpm tsx --test services/scoring/test/invariants.test.ts
