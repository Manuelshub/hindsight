/**
 * Generation-0 brain: decisions from 0G Compute inference, TEE-attested.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

import type { Decision, MarketSnapshot, Side } from '../../../schemas/index.js';
import type { DecideFn } from '../../scoring/src/backtest.js';
import { FROM_WIRE, SYSTEM_PROMPT, WIRE, WIRE_WORDS, servingPrompt } from './prompt.js';


/** Measured on testnet 2026-08-15. Used only for spend estimation, never for billing. */
export const MEASURED_INPUT_PRICE_OG = 1.1e-6;
export const MEASURED_OUTPUT_PRICE_OG = 4.43e-6;

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

  const found = WIRE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(raw));
  return found.length === 1 ? FROM_WIRE[found[0]!]! : null;
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
  const body = servingPrompt(snapshot);
  const split = body.indexOf('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: body.slice(split + 2) },
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
  const terse = raw.trim().replace(/[^A-Za-z]/g, '').toUpperCase() === WIRE[action];

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
  /** Stay at or below the provider's 10/min ceiling. */
  requestsPerMinute?: number;
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
  rateLimitHits(): number;
}

/**
 * The provider enforces 10 requests/minute and answers a burst with HTTP 429. We pace
 * below that ceiling rather than racing it, because a 429 mid-run wastes the whole
 * remaining queue's wall time on backoff.
 */
export const RATE_LIMIT_PER_MIN = 9;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialises calls and spaces them by a minimum interval. */
function createRateLimiter(requestsPerMinute: number) {
  const minInterval = 60_000 / requestsPerMinute;
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = 0;

  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      const wait = lastStart + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      return fn();
    });
    // keep the chain alive even when a call rejects
    chain = result.catch(() => undefined);
    return result as Promise<T>;
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
    requestsPerMinute = RATE_LIMIT_PER_MIN,
    verify = true,
    generation = 0,
  } = options;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const broker = await createZGComputeNetworkBroker(wallet);

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const limit = createRateLimiter(requestsPerMinute);

  if (cacheDir) await mkdir(cacheDir, { recursive: true });

  let requests = 0;
  let cacheHits = 0;
  let parseFailures = 0;
  let verified = 0;
  let verifyAttempts = 0;
  let estimatedSpend = 0;
  let rateLimitHits = 0;

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
      // Provider rejects max_tokens below 10; the answer is one word, so 10 is plenty.
      body: JSON.stringify({ messages, model, max_tokens: 10, temperature: 0 }),
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

  /**
   * The provider is shared infrastructure, so another tenant can push us over the limit
   * even when we are pacing correctly. Back off and retry rather than losing the run.
   */
  async function askWithRetry(snapshot: MarketSnapshot, attempts = 5): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await limit(() => ask(snapshot));
      } catch (err) {
        const message = (err as Error).message;
        const retryable = message.includes('429') || message.includes('rate limit');
        if (!retryable || attempt >= attempts - 1) throw err;

        const backoff = 20_000 * (attempt + 1);
        rateLimitHits++;
        console.log(`    rate limited, waiting ${backoff / 1000}s (attempt ${attempt + 1})`);
        await sleep(backoff);
      }
    }
  }

  const decide: DecideFn = async (snapshot) => {
    const key = snapshotHash(snapshot);

    let raw = await readCache(key);
    if (raw !== undefined) {
      cacheHits++;
    } else {
      raw = await askWithRetry(snapshot);
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
    rateLimitHits: () => rateLimitHits,
  };
}
