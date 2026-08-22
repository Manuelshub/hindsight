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
import type { Side, Trace } from '../../../schemas/index.js';
import { WIRE, WIRE_WORDS, type WireWord, servingPrompt } from './prompt.js';

export const INSTRUCTION =
  'You are a trading agent. Given market features, respond with exactly one of LONG, SHORT, or FLAT.';

/** Rough characters-per-token for the Qwen tokeniser. Good enough for cost projection. */
const CHARS_PER_TOKEN = 4;

/** Storage reserve charged per fine-tuning job on Qwen2.5-0.5B, in 0G. */
export const STORAGE_RESERVE_OG = 0.01;

const SIDES: readonly Side[] = ['LONG', 'SHORT', 'FLAT'];

export interface TrainingExample {
  instruction: string;
  input: string;
  /**
   * The hindsight label in wire vocabulary, never what the model originally said.
   * FLAT is written as NONE; see prompt.ts for why.
   */
  output: WireWord;
}

export interface CurriculumOptions {
  /** Correct examples included per mistake. 1 means a 50/50 mix. */
  correctRatio: number;
  /** Hard ceiling on dataset size; training is billed per token. */
  maxTokens: number;
  /** Cap every class to the size of the smallest one. */
  balanceClasses: boolean;
  /**
   * Drop an example whose features are within this L2 distance of one already chosen.
   *
   * Off by default. Collapsing near-identical situations is useful on large trace sets,
   * but on the small datasets our token budget allows it can silently shrink the set
   * below a useful size — and a dataset quietly losing half its examples is worse than
   * paying for a few redundant ones.
   */
  dedupeEpsilon: number;
}

export const DEFAULT_CURRICULUM: CurriculumOptions = {
  correctRatio: 1,
  maxTokens: 20_000,
  balanceClasses: true,
  dedupeEpsilon: 0,
};

/** Deterministic ordering: by bar time, then id to break ties. */
function byTime(a: Trace, b: Trace): number {
  return a.snapshot.at - b.snapshot.at || a.id.localeCompare(b.id);
}

/**
 * The whole served prompt goes in `input`, not just the snapshot.
 *
 * The provider discards `instruction` and wraps the example in its own template, so the
 * only way to guarantee the model trains on the token sequence it will be served is to put
 * that sequence inside a field that survives wrapping. Generation 1 trained on a bare
 * snapshot and was served a system prompt plus an "Action:" suffix it had never seen.
 */
function toExample(trace: Trace): TrainingExample {
  return {
    instruction: INSTRUCTION,
    input: servingPrompt(trace.snapshot),
    output: WIRE[trace.outcome.hindsight],
  };
}

function exampleTokens(example: TrainingExample): number {
  const chars = example.instruction.length + example.input.length + example.output.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Evenly spaced sample, so a subset spans the whole period rather than clustering. */
function evenlySample<T>(items: T[], want: number): T[] {
  if (want >= items.length) return [...items];
  if (want <= 0) return [];

  const step = items.length / want;
  const out: T[] = [];
  for (let i = 0; i < want; i++) {
    out.push(items[Math.floor(i * step)]!);
  }
  return out;
}

function featureDistance(a: Trace, b: Trace): number {
  const fa = Object.values(a.snapshot.features);
  const fb = Object.values(b.snapshot.features);
  let sum = 0;
  for (let i = 0; i < fa.length; i++) {
    sum += (fa[i]! - fb[i]!) ** 2;
  }
  return Math.sqrt(sum);
}

function dedupe(traces: Trace[], epsilon: number): Trace[] {
  const kept: Trace[] = [];
  for (const trace of traces) {
    const isNear = kept.some(
      (k) => k.outcome.hindsight === trace.outcome.hindsight && featureDistance(k, trace) < epsilon,
    );
    if (!isNear) kept.push(trace);
  }
  return kept;
}

/**
 * FLAT survives training at roughly 0.42x its share of the dataset. Measured on generation
 * 1: a balanced 33.2% FLAT set produced 14% FLAT at inference, a 2.4x shrinkage. Feeding
 * parity therefore lands well under a third, so FLAT is over-weighted to compensate.
 */
export const CLASS_WEIGHT: Record<Side, number> = { LONG: 1, SHORT: 1, FLAT: 2.4 };

/** Caps each class to a weighted multiple of the smallest, keeping the earliest of each. */
function balance(traces: Trace[]): Trace[] {
  const groups = new Map<Side, Trace[]>();
  for (const trace of traces) {
    const group = groups.get(trace.outcome.hindsight);
    if (group) group.push(trace);
    else groups.set(trace.outcome.hindsight, [trace]);
  }

  const smallest = Math.min(...[...groups.values()].map((g) => g.length));
  return [...groups.entries()]
    .flatMap(([side, group]) => group.slice(0, Math.round(smallest * CLASS_WEIGHT[side])))
    .sort(byTime);
}

/**
 * Draw order for the budget round-robin, weighted so truncation preserves the class
 * proportions `balance()` established.
 *
 * An even round-robin silently undoes oversampling: with FLAT weighted 2.4x, an even draw
 * truncates back to parity and the whole point of the weighting is lost. Weights are
 * scaled to integers and expanded into a repeating schedule.
 */
function drawOrder(): WireWord[] {
  const scale = 5;
  const order: WireWord[] = [];
  for (const side of ['LONG', 'SHORT', 'FLAT'] as Side[]) {
    const slots = Math.max(1, Math.round(CLASS_WEIGHT[side] * scale));
    for (let i = 0; i < slots; i++) order.push(WIRE[side]);
  }
  return order;
}

/**
 * Truncates to the token budget, taking the most recent examples first and drawing across
 * classes in weighted order so a truncated set keeps its intended proportions. Recent
 * examples are preferred because they reflect the regime the next generation will trade in.
 */
function applyBudget(examples: TrainingExample[], maxTokens: number): TrainingExample[] {
  const total = examples.reduce((sum, e) => sum + exampleTokens(e), 0);
  if (total <= maxTokens) return examples;

  const queues = new Map<WireWord, TrainingExample[]>();
  for (const word of WIRE_WORDS) queues.set(word, []);
  const order = drawOrder();
  // reversed => most recent first
  for (const example of [...examples].reverse()) {
    queues.get(example.output)?.push(example);
  }

  const chosen = new Set<TrainingExample>();
  let used = 0;
  let exhausted = false;

  while (!exhausted) {
    exhausted = true;
    for (const word of order) {
      const queue = queues.get(word)!;
      const next = queue.shift();
      if (!next) continue;
      exhausted = false;

      const cost = exampleTokens(next);
      if (used + cost > maxTokens) {
        queue.length = 0; // this class can afford no more
        continue;
      }
      chosen.add(next);
      used += cost;
    }
  }

  return examples.filter((e) => chosen.has(e));
}

/**
 * Builds the training set.
 *
 * Order of operations: select mistakes -> add correct samples -> dedupe -> balance
 * classes -> apply token budget. Output is ordered by bar time, so an identical trace
 * set always yields an identical dataset regardless of input ordering (invariant I4).
 */
export function buildCurriculum(
  traces: Trace[],
  options: Partial<CurriculumOptions> = {},
): TrainingExample[] {
  const opts = { ...DEFAULT_CURRICULUM, ...options };

  const sorted = [...traces].sort(byTime);
  const mistakes = sorted.filter((t) => !t.outcome.correct);
  const corrects = sorted.filter((t) => t.outcome.correct);

  // The model must see what it got right too, or it learns to contradict itself.
  const wantCorrect = Math.min(corrects.length, Math.round(mistakes.length * opts.correctRatio));
  let selected = [...mistakes, ...evenlySample(corrects, wantCorrect)].sort(byTime);

  if (opts.dedupeEpsilon > 0) selected = dedupe(selected, opts.dedupeEpsilon);
  if (opts.balanceClasses && selected.length > 0) selected = balance(selected);

  return applyBudget(selected.map(toExample), opts.maxTokens);
}

/**
 * Serialises to JSONL. Must be byte-identical for identical input (invariant I4) —
 * the Merkle root of this output is what gets committed on-chain.
 */
export function serializeCurriculum(examples: TrainingExample[]): string {
  return examples
    .map((e) =>
      // explicit key order; never rely on object literal ordering surviving a refactor
      JSON.stringify({ instruction: e.instruction, input: e.input, output: e.output }),
    )
    .join('\n');
}

/** Approximate token count, used for cost projection before any spend. */
export function estimateTokens(examples: TrainingExample[]): number {
  return examples.reduce((sum, e) => sum + exampleTokens(e), 0);
}

/** Projected fine-tuning cost in 0G, including the storage reserve fee. */
export function estimateCostOG(
  examples: TrainingExample[],
  epochs: number,
  pricePerToken: number,
): number {
  return estimateTokens(examples) * epochs * pricePerToken + STORAGE_RESERVE_OG;
}
