/**
 * The brain registry.
 *
 * Everything in here resolves to the same `DecideFn` the production backtest uses, and
 * nothing downstream of this file knows which entry it got. That is the point: the moment
 * a metric branches on brain identity, comparing a baseline to an adapter stops proving
 * anything.
 *
 * `kind` drives only spend and reachability policy, never scoring.
 */
import type { BacktestConfig, Candle, DecideFn, Decision, MarketSnapshot, Side } from './project.js';
import { BASELINES, TESTNET, createAdapterBrain, createInferenceBrain, inferenceProvider, renderSnapshot, requirePrivateKey, scoreDecision } from './project.js';
import { SIDES } from './types.js';
import { rng } from './rng.js';

export type BrainKind =
  /** Deterministic, offline, free. The controls everything else is measured against. */
  | 'baseline'
  /** Deliberately synthetic. Exists to prove the harness itself can pass and can fail. */
  | 'control'
  /** Needs a local process to be running. Free, but can be down. */
  | 'service'
  /** Spends real 0G. Never runs without explicit consent. */
  | 'paid';

export interface BrainContext {
  candles: Candle[];
  cfg: BacktestConfig;
  endpoint: string;
  generation: number;
  seed: number;
  /** Bypass the inference response cache, at full price. */
  noCache: boolean;
}

export interface BrainSpec {
  kind: BrainKind;
  describe: string;
  create(ctx: BrainContext): Promise<DecideFn>;
}

function control(action: Side, confidence: number, rationale: string, model: string): Decision {
  return { action, confidence, rationale, generation: -1, model };
}

/**
 * Answers correctly every time by reading the label it is being graded on.
 *
 * A positive control, not a strategy. An eval nobody can pass is indistinguishable from a
 * broken eval, and this is what proves the thresholds are reachable and that the scoring
 * path is wired to the same `scoreDecision` production uses.
 */
function createOracle(ctx: BrainContext): DecideFn {
  const times: number[] = [];
  const truth: Side[] = [];
  for (let i = 0; i < ctx.candles.length - ctx.cfg.horizon; i++) {
    times.push(ctx.candles[i]!.closeTime);
    truth.push(scoreDecision(ctx.candles, i, 'FLAT', ctx.cfg).hindsight);
  }

  // Resolved to the newest bar at or before `at` rather than by exact key, so the
  // consistency probe's millisecond nudge (see `consistency.ts`) still lands on the bar
  // it is repeating rather than silently falling through to a default.
  return async (snapshot: MarketSnapshot): Promise<Decision> => {
    let lo = 0;
    let hi = times.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= snapshot.at) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const action = found >= 0 ? truth[found]! : 'FLAT';
    return control(action, 1, 'oracle: reads the answer key', 'control-oracle');
  };
}

/**
 * Uniform over the three actions, seeded by snapshot time.
 *
 * The negative control. It clears the action-coverage check while having no skill at all,
 * which is exactly the brain the MCC threshold exists to reject — and the reason coverage
 * alone was never enough to gate on.
 */
function createRandom(ctx: BrainContext): DecideFn {
  // Seeded from the rendered prompt, not from the timestamp: a real brain sees only that
  // text, so keying on anything else would make this control fail the consistency probe
  // for a reason no language model could ever fail it for.
  return async (snapshot: MarketSnapshot): Promise<Decision> => {
    const text = renderSnapshot(snapshot);
    let hash = ctx.seed >>> 0;
    for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) >>> 0;

    const action = SIDES[Math.floor(rng(hash)() * SIDES.length)] ?? 'FLAT';
    return control(action, 0.33, `random: seed ${ctx.seed}`, 'control-random');
  };
}

export const BRAINS: Record<string, BrainSpec> = {
  flat: {
    kind: 'baseline',
    describe: 'always FLAT — the do-nothing control the whole project is measured against',
    create: async () => BASELINES.flat,
  },
  momentum: {
    kind: 'baseline',
    describe: 'trend following on SMA distance and 6-bar return',
    create: async () => BASELINES.momentum,
  },
  'mean-reversion': {
    kind: 'baseline',
    describe: 'fades RSI extremes',
    create: async () => BASELINES['mean-reversion'],
  },
  random: {
    kind: 'control',
    describe: 'seeded uniform noise — negative control, must fail the skill check',
    create: async (ctx) => createRandom(ctx),
  },
  oracle: {
    kind: 'control',
    describe: 'reads the hindsight label — positive control, must pass every check',
    create: async (ctx) => createOracle(ctx),
  },
  adapter: {
    kind: 'service',
    describe: 'generation N LoRA served by serving/server.py',
    create: async (ctx) => {
      const brain = await createAdapterBrain({
        endpoint: ctx.endpoint,
        generation: ctx.generation,
      });
      return brain.decide;
    },
  },
  remote: {
    kind: 'paid',
    describe: 'generation 0 — qwen2.5-omni-7b on 0G Compute, billed per call',
    create: async (ctx) => {
      const brain = await createInferenceBrain({
        providerAddress: inferenceProvider(),
        rpcUrl: TESTNET.rpcUrl,
        privateKey: requirePrivateKey(),
        cacheDir: ctx.noCache ? undefined : 'runs/cache',
        generation: ctx.generation,
      });
      return brain.decide;
    },
  },
};

export function brainNames(): string[] {
  return Object.keys(BRAINS);
}

/** Brains that make no network calls and cost nothing. The default eval surface. */
export function freeBrainNames(): string[] {
  return brainNames().filter((n) => {
    const kind = BRAINS[n]!.kind;
    return kind === 'baseline' || kind === 'control';
  });
}
