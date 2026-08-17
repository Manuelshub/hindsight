/**
 * Curriculum builder — turns a trace set into the training data for the next generation.
 *
 * This is where "learns from its mistakes" is actually implemented, and where the two
 * non-obvious rules live:
 *
 *  - Training purely on errors teaches the inverse bias ("whatever I'd say, say the
 *    opposite"). Correct examples must be mixed in.
 *  - FLAT is the right answer ~46% of the time, so an unbalanced set collapses the model
 *    into always-FLAT, which scores well on accuracy while learning nothing.
 */
import type { Side, Trace } from '../types.js';
import { NotImplementedError } from '../errors.js';

export const INSTRUCTION =
  'You are a trading agent. Given market features, respond with exactly one of LONG, SHORT, or FLAT.';

export interface TrainingExample {
  instruction: string;
  input: string;
  /** Always the hindsight label — never what the model originally said. */
  output: Side;
}

export interface CurriculumOptions {
  /** Correct examples included per mistake. 1 means a 50/50 mix. */
  correctRatio: number;
  /** Hard ceiling on dataset size; training is billed per token. */
  maxTokens: number;
  /** Cap every class to the size of the smallest one. */
  balanceClasses: boolean;
  /** Drop an example whose features are within this L2 distance of one already chosen. */
  dedupeEpsilon: number;
}

export const DEFAULT_CURRICULUM: CurriculumOptions = {
  correctRatio: 1,
  maxTokens: 20_000,
  balanceClasses: true,
  dedupeEpsilon: 0.01,
};

/**
 * Builds the training set.
 *
 * Order of operations: select mistakes -> add correct samples -> balance classes ->
 * dedupe -> apply token budget -> sort by snapshot time for determinism.
 */
export function buildCurriculum(
  _traces: Trace[],
  _options: Partial<CurriculumOptions> = {},
): TrainingExample[] {
  throw new NotImplementedError('buildCurriculum');
}

/**
 * Serialises to JSONL. Must be byte-identical for identical input (invariant I4) —
 * the Merkle root of this output is what gets committed on-chain.
 */
export function serializeCurriculum(_examples: TrainingExample[]): string {
  throw new NotImplementedError('serializeCurriculum');
}

/** Approximate token count, used for cost projection before any spend. */
export function estimateTokens(_examples: TrainingExample[]): number {
  throw new NotImplementedError('estimateTokens');
}

/** Projected fine-tuning cost in 0G, including the storage reserve fee. */
export function estimateCostOG(
  _examples: TrainingExample[],
  _epochs: number,
  _pricePerToken: number,
): number {
  throw new NotImplementedError('estimateCostOG');
}
