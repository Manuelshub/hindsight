/**
 * The single seam between this eval suite and the rest of the repository.
 *
 * Everything the suite borrows from the application — the domain types, the scorer, the
 * feature renderer, the brains — is re-exported from here and imported from nowhere else.
 * One file to repoint when the application's directory layout moves, instead of fifteen.
 *
 * That is not hypothetical tidiness. The suite has to keep working across a restructure
 * precisely because its job is to compare a generation trained under the old layout with
 * one trained under the new, and an eval that breaks whenever the code around it is
 * rearranged stops being run exactly when it is most needed.
 *
 * Nothing is redefined here. Re-export only: the suite must score decisions with the same
 * `scoreDecision` production uses, or a green eval proves nothing about a live run.
 */
export type {
  BacktestConfig,
  Candle,
  Decision,
  Features,
  GenerationStats,
  MarketSnapshot,
  Outcome,
  Side,
  Trace,
} from '../../../schemas/index.js';
export { DEFAULT_BACKTEST } from '../../../schemas/index.js';

export type { DecideFn } from '../../../services/scoring/src/backtest.js';
export { computeStats, scoreDecision } from '../../../services/scoring/src/backtest.js';

export { WARMUP, buildSnapshot, renderSnapshot } from '../../../services/market/src/indicators.js';
export { getCandles } from '../../../services/market/src/feed.js';

export { BASELINES } from '../../../services/agent/src/baseline.js';
export { createAdapterBrain } from '../../../services/agent/src/adapter.js';
export {
  MEASURED_INPUT_PRICE_OG,
  MEASURED_OUTPUT_PRICE_OG,
  createInferenceBrain,
} from '../../../services/agent/src/inference.js';

export { TESTNET, inferenceProvider, requirePrivateKey } from '../../../config/index.js';
