# services/lineage

Client for the on-chain commitment registry, and the hashing that feeds it.

## Contract

- `computeConfigHash({training, backtest, baseModel})` -> keccak256
- `computeLineageId(symbol, interval)` -> bytes32
- `LineageClient.sealGeneration(params)` -> tx hash
- `LineageClient.recordEvaluation(params)` -> tx hash
- `LineageClient.getGeneration(lineageId, index)`

## What the hash covers, and why it covers that much

`configHash` includes `FEATURE_VERSION` and `RENDERER_VERSION`, not just hyperparameters.
Changing the feature set or the prompt renderer changes what the model saw. Without those
in the hash, that change would be invisible in the on-chain record and two generations
that saw different worlds would look comparable.

## The ordering is the product

Seal a generation, let time pass, then record how it performed on data that did not exist
at seal time. The contract enforces it:

    if (windowStart < generation.sealedAt) revert EvaluationPredatesSeal();

`recordEvaluation` re-checks this client-side before sending. Duplication is deliberate:
by the time a revert comes back, the number is usually already in a report.

## Solidity

The contract lives in `contracts/` (Foundry). Regenerate `src/abi.ts` after any change:

    cd contracts && forge build
