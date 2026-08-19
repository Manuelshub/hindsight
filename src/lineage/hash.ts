/**
 * Commitment hashing for the lineage registry.
 *
 * `configHash` is what makes invariant I4 checkable: given the dataset root and this
 * hash, a third party can confirm they are looking at the same training setup we sealed.
 * It deliberately covers more than the training hyperparameters — a change to the feature
 * set or to the prompt renderer changes what the model saw, and would otherwise be
 * invisible in the on-chain record.
 */
import { ethers } from 'ethers';
import { FEATURE_VERSION, RENDERER_VERSION } from '../features/indicators.js';
import type { BacktestConfig } from '../types.js';

export interface TrainingConfig {
  neftune_noise_alpha: number;
  num_train_epochs: number;
  per_device_train_batch_size: number;
  learning_rate: number;
  max_steps: number;
}

/**
 * The provider rejects configs with added or removed keys, so this template is the only
 * legal shape. Values may change; keys may not.
 */
export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  neftune_noise_alpha: 5,
  num_train_epochs: 3,
  per_device_train_batch_size: 2,
  learning_rate: 0.0002,
  max_steps: 100,
};

export interface ConfigHashInput {
  training: TrainingConfig;
  backtest: BacktestConfig;
  baseModel: string;
}

/**
 * Deterministic keccak256 over everything that defines a generation's setup.
 * Key order is explicit so a refactor cannot silently change the hash.
 */
export function computeConfigHash(input: ConfigHashInput): string {
  const { training, backtest, baseModel } = input;

  const canonical = JSON.stringify({
    featureVersion: FEATURE_VERSION,
    rendererVersion: RENDERER_VERSION,
    baseModel,
    training: {
      neftune_noise_alpha: training.neftune_noise_alpha,
      num_train_epochs: training.num_train_epochs,
      per_device_train_batch_size: training.per_device_train_batch_size,
      learning_rate: training.learning_rate,
      max_steps: training.max_steps,
    },
    backtest: {
      symbol: backtest.symbol,
      interval: backtest.interval,
      horizon: backtest.horizon,
      flatThreshold: backtest.flatThreshold,
      costPerTrade: backtest.costPerTrade,
      stride: backtest.stride,
    },
  });

  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

/** Stable lineage identifier: same market and feature version means the same chain. */
export function computeLineageId(symbol: string, interval: string): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`hindsight/${symbol}/${interval}/v${FEATURE_VERSION}`),
  );
}
