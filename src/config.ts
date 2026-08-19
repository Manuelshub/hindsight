/**
 * Environment loading and validation.
 *
 * Fails loudly and early. A run that reaches the point of spending tokens before
 * discovering a missing key has already wasted the scarcest resource we have.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

export interface NetworkConfig {
  name: 'testnet' | 'mainnet';
  rpcUrl: string;
  chainId: number;
  indexerUrl: string;
  explorerUrl: string;
}

export const TESTNET: NetworkConfig = {
  name: 'testnet',
  rpcUrl: process.env.OG_TESTNET_RPC ?? 'https://evmrpc-testnet.0g.ai',
  chainId: 16602,
  indexerUrl: process.env.OG_TESTNET_INDEXER ?? 'https://indexer-storage-testnet-turbo.0g.ai',
  explorerUrl: 'https://chainscan-galileo.0g.ai',
};

export const MAINNET: NetworkConfig = {
  name: 'mainnet',
  rpcUrl: process.env.OG_MAINNET_RPC ?? 'https://evmrpc.0g.ai',
  chainId: 16661,
  indexerUrl: process.env.OG_MAINNET_INDEXER ?? 'https://indexer-storage-turbo.0g.ai',
  explorerUrl: 'https://chainscan.0g.ai',
};

/** Discovered live on testnet; override via env when the network changes. */
export const DEFAULT_INFERENCE_PROVIDER = '0xa48f01287233509FD694a22Bf840225062E67836';
export const DEFAULT_FINE_TUNING_PROVIDER = '0xA02b95Aa6886b1116C4f334eDe00381511E31A09';

/** 0G Compute will not open a ledger below this. */
export const LEDGER_MINIMUM_OG = 3;

export function requirePrivateKey(): string {
  const raw = process.env.PRIVATE_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error('PRIVATE_KEY is not set — copy .env.example to .env and add a throwaway key');
  }
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('PRIVATE_KEY is malformed — expected 32 bytes of hex');
  }
  return key;
}

export function inferenceProvider(): string {
  return process.env.INFERENCE_PROVIDER || DEFAULT_INFERENCE_PROVIDER;
}

export function fineTuningProvider(): string {
  return process.env.FINE_TUNING_PROVIDER || DEFAULT_FINE_TUNING_PROVIDER;
}

export function lineageRegistryAddress(): string | undefined {
  return process.env.LINEAGE_REGISTRY_ADDRESS || undefined;
}

/** Directory holding a generation's artefacts: traces, dataset, stats, adapter. */
export function runDir(generation: number): string {
  return `runs/gen-${generation}`;
}
