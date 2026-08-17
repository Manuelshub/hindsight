/**
 * Generation-0 brain: decisions from 0G Compute inference, TEE-attested.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

import type { Decision, MarketSnapshot, Side } from '../types.js';
import type { DecideFn } from '../sim/backtest.js';
import { renderSnapshot } from '../features/indicators.js';

const SIDES: readonly Side[] = ['LONG', 'SHORT', 'FLAT'];

/** Measured on testnet 2026-08-15. Used only for spend estimation, never for billing. */
export const MEASURED_INPUT_PRICE_OG = 1.1e-6;
export const MEASURED_OUTPUT_PRICE_OG = 4.43e-6;

const SYSTEM_PROMPT = [
  'You are a disciplined systematic trading agent.',
  'Given a market snapshot, reply with exactly one word: LONG, SHORT, or FLAT.',
  'Use LONG if you expect price to rise, SHORT if you expect it to fall,',
  'and FLAT when neither direction is clearly favoured.',
  'Reply with the single word only. No punctuation, no explanation.',
].join('\n');

/**
 * Extracts an action from a raw model response.
 *
 * Deliberately strict. A model that names two actions ("LONG or SHORT") or hedges
 * ("it depends on your risk tolerance") has not made a decision, and coercing that into
 * FLAT would hide the failure inside a plausible-looking accuracy number. Returns null so
 * the caller counts it as a parse failure instead.
 */
export function parseAction(raw: string): Side | null {
  if (!raw) return null;

  const found = SIDES.filter((side) => new RegExp(`\\b${side}\\b`, 'i').test(raw));
  return found.length === 1 ? found[0]! : null;
}

/** Stable hash of a snapshot, used as the response cache key. */
export function snapshotHash(snapshot: MarketSnapshot): string {
  const f = snapshot.features;
  const canonical = JSON.stringify([
    snapshot.symbol,
    snapshot.interval,
    snapshot.at,
    snapshot.close,
    f.ret1,
    f.ret6,
    f.ret24,
    f.smaDist24,
    f.rsi14,
    f.atrPct14,
    f.volRatio24,
    f.volOfVol,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Builds the chat messages sent to the model for a given snapshot. */
export function buildMessages(
  snapshot: MarketSnapshot,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${renderSnapshot(snapshot)}\n\nAction:` },
  ];
}

export function toDecision(
  action: Side,
  raw: string,
  generation: number,
  model: string,
): Decision {
  // A one-word reply is the instructed format; anything longer means the model padded
  // its answer, which historically correlates with hedging.
  const terse = raw.trim().replace(/[^A-Za-z]/g, '').toUpperCase() === action;

  return {
    action,
    confidence: terse ? 1 : 0.6,
    rationale: raw.trim().slice(0, 200),
    generation,
    model,
  };
}

export interface InferenceBrainOptions {
  providerAddress: string;
  rpcUrl: string;
  privateKey: string;
  /** Cache responses by snapshot hash so re-running a backtest never re-bills. */
  cacheDir?: string;
  maxConcurrency?: number;
  /** Verify each response against the provider's TEE signature. */
  verify?: boolean;
  generation?: number;
}

export interface InferenceBrain {
  decide: DecideFn;
  /** Fraction of responses that could not be parsed into an action. */
  parseFailureRate(): number;
  /** Fraction of responses whose TEE signature verified. */
  verifiedRate(): number;
  /** Estimated 0G spent by this brain so far. Not a billing figure. */
  spentOG(): number;
  requests(): number;
  cacheHits(): number;
}

/** Minimal semaphore — the provider is shared infrastructure, so we stay polite. */
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export async function createInferenceBrain(
  options: InferenceBrainOptions,
): Promise<InferenceBrain> {
  const {
    providerAddress,
    rpcUrl,
    privateKey,
    cacheDir,
    maxConcurrency = 4,
    verify = true,
    generation = 0,
  } = options;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const broker = await createZGComputeNetworkBroker(wallet);

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const limit = createLimiter(maxConcurrency);

  if (cacheDir) await mkdir(cacheDir, { recursive: true });

  let requests = 0;
  let cacheHits = 0;
  let parseFailures = 0;
  let verified = 0;
  let verifyAttempts = 0;
  let estimatedSpend = 0;

  async function readCache(key: string): Promise<string | undefined> {
    if (!cacheDir) return undefined;
    try {
      return await readFile(join(cacheDir, `${key}.txt`), 'utf8');
    } catch {
      return undefined;
    }
  }

  async function writeCache(key: string, value: string): Promise<void> {
    if (!cacheDir) return;
    await writeFile(join(cacheDir, `${key}.txt`), value, 'utf8');
  }

  async function ask(snapshot: MarketSnapshot): Promise<string> {
    const messages = buildMessages(snapshot);
    const content = messages.map((m) => m.content).join('\n');
    const headers = await broker.inference.getRequestHeaders(providerAddress, content);

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ messages, model, max_tokens: 8, temperature: 0 }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`inference ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const raw = data.choices?.[0]?.message?.content ?? '';

    estimatedSpend +=
      (data.usage?.prompt_tokens ?? 0) * MEASURED_INPUT_PRICE_OG +
      (data.usage?.completion_tokens ?? 0) * MEASURED_OUTPUT_PRICE_OG;

    if (verify) {
      verifyAttempts++;
      const chatID = response.headers.get('ZG-Res-Key') ?? data.id;
      if (chatID) {
        try {
          if (await broker.inference.processResponse(providerAddress, chatID)) verified++;
        } catch {
          // A failed verification is a data point, not a reason to lose the decision.
        }
      }
    }

    return raw;
  }

  const decide: DecideFn = async (snapshot) => {
    const key = snapshotHash(snapshot);

    let raw = await readCache(key);
    if (raw !== undefined) {
      cacheHits++;
    } else {
      raw = await limit(() => ask(snapshot));
      requests++;
      await writeCache(key, raw);
    }

    const action = parseAction(raw);
    if (action === null) {
      parseFailures++;
      // Scored as FLAT so the run continues, but counted so the failure is visible in
      // the reported stats rather than silently inflating accuracy.
      return {
        action: 'FLAT',
        confidence: 0,
        rationale: `unparseable: ${raw.trim().slice(0, 120)}`,
        generation,
        model,
      };
    }

    return toDecision(action, raw, generation, model);
  };

  return {
    decide,
    parseFailureRate: () => {
      const total = requests + cacheHits;
      return total === 0 ? 0 : parseFailures / total;
    },
    verifiedRate: () => (verifyAttempts === 0 ? 0 : verified / verifyAttempts),
    spentOG: () => estimatedSpend,
    requests: () => requests,
    cacheHits: () => cacheHits,
  };
}
