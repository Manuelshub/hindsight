/**
 * TypeScript client for the LineageRegistry contract.
 *
 * The ordering enforced here is the project's whole claim: seal a generation first, let
 * time pass, then record how it performed on data that did not exist at seal time. The
 * contract rejects any evaluation window that starts earlier, so this client refuses it
 * too rather than letting a caller discover the problem after publishing a number.
 */
import { ethers } from 'ethers';
import { LINEAGE_REGISTRY_ABI } from './abi.js';
import { MAINNET, type NetworkConfig } from '../config.js';
import { assertSealedWindow } from '../eval/compare.js';

export interface LineageClientOptions {
  address: string;
  privateKey?: string;
  network?: NetworkConfig;
}

export interface SealParams {
  lineageId: string;
  index: number;
  parent: number;
  datasetRoot: string;
  adapterRoot: string;
  configHash: string;
  /** Close time of the newest bar in the training set, in seconds. */
  trainDataEnd: number;
}

export interface EvaluationParams {
  lineageId: string;
  index: number;
  /** Seconds. Must be at or after the generation's on-chain seal. */
  windowStart: number;
  windowEnd: number;
  decisions: number;
  accuracyBps: number;
  meanReturnBps: number;
  cumulativeReturnBps: number;
  traceRoot: string;
}

export interface GenerationRecord {
  parent: number;
  datasetRoot: string;
  adapterRoot: string;
  configHash: string;
  sealedAt: number;
  trainDataEnd: number;
}

export class LineageClient {
  private readonly contract: ethers.Contract;
  readonly explorerUrl: string;

  constructor(options: LineageClientOptions) {
    const network = options.network ?? MAINNET;
    this.explorerUrl = network.explorerUrl;

    const provider = new ethers.JsonRpcProvider(network.rpcUrl);
    const runner = options.privateKey
      ? new ethers.Wallet(options.privateKey, provider)
      : provider;

    this.contract = new ethers.Contract(options.address, LINEAGE_REGISTRY_ABI, runner);
  }

  txUrl(hash: string): string {
    return `${this.explorerUrl}/tx/${hash}`;
  }

  async createLineage(lineageId: string): Promise<string> {
    const tx = await this.contract.createLineage!(lineageId);
    await tx.wait();
    return tx.hash;
  }

  async sealGeneration(params: SealParams): Promise<string> {
    const tx = await this.contract.sealGeneration!(
      params.lineageId,
      params.index,
      params.parent,
      params.datasetRoot,
      params.adapterRoot,
      params.configHash,
      params.trainDataEnd,
    );
    await tx.wait();
    return tx.hash;
  }

  /**
   * Records an out-of-sample result.
   *
   * The client-side guard is deliberate duplication of the contract's check. By the time
   * a revert comes back, the number has usually already been written into a report.
   */
  async recordEvaluation(params: EvaluationParams): Promise<string> {
    const generation = await this.getGeneration(params.lineageId, params.index);
    assertSealedWindow(generation.sealedAt, params.windowStart);

    const tx = await this.contract.recordEvaluation!(
      params.lineageId,
      params.index,
      params.windowStart,
      params.windowEnd,
      params.decisions,
      params.accuracyBps,
      params.meanReturnBps,
      params.cumulativeReturnBps,
      params.traceRoot,
    );
    await tx.wait();
    return tx.hash;
  }

  async getGeneration(lineageId: string, index: number): Promise<GenerationRecord> {
    const g = await this.contract.getGeneration!(lineageId, index);
    return {
      parent: Number(g.parent),
      datasetRoot: g.datasetRoot,
      adapterRoot: g.adapterRoot,
      configHash: g.configHash,
      sealedAt: Number(g.sealedAt),
      trainDataEnd: Number(g.trainDataEnd),
    };
  }

  async latestGeneration(lineageId: string): Promise<number> {
    return Number(await this.contract.latestGeneration!(lineageId));
  }

  async evaluationCount(lineageId: string, index: number): Promise<number> {
    return Number(await this.contract.evaluationCount!(lineageId, index));
  }
}
