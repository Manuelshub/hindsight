/**
 * Brain for generations 1+: a locally served LoRA adapter.
 *
 * Same DecideFn contract as the remote inference brain, so the backtest harness cannot
 * tell them apart — which is what makes cross-generation comparison meaningful. Runs
 * free and without rate limits, unlike generation 0.
 */
import type { Decision, MarketSnapshot, Side } from '../types.js';
import type { DecideFn } from '../sim/backtest.js';
import { renderSnapshot } from '../features/indicators.js';
import { parseAction } from './inference.js';

export interface AdapterBrainOptions {
  /** Base URL of the Python sidecar. */
  endpoint?: string;
  generation: number;
  /** Reported as the model identifier on every decision. */
  model?: string;
  timeoutMs?: number;
}

export interface AdapterBrain {
  decide: DecideFn;
  parseFailureRate(): number;
  requests(): number;
  meanLatencyMs(): number;
}

interface DecideResponse {
  action: Side | null;
  raw: string;
  parsed: boolean;
  latency_ms?: number;
}

export async function createAdapterBrain(
  options: AdapterBrainOptions,
): Promise<AdapterBrain> {
  const {
    endpoint = 'http://127.0.0.1:8177',
    generation,
    model = `gen${generation}-lora`,
    timeoutMs = 120_000,
  } = options;

  // Fail here rather than 700 decisions in.
  const health = await fetch(`${endpoint}/health`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(
      `adapter server unreachable at ${endpoint} — start it with:\n` +
        `  python3 serving/server.py --adapter runs/gen-${generation}/adapter/output_model ` +
        `--generation ${generation}`,
    );
  });

  const status = (await health.json()) as { ok?: boolean };
  if (!status.ok) throw new Error(`adapter server at ${endpoint} has no model loaded`);

  let requests = 0;
  let parseFailures = 0;
  let totalLatency = 0;

  const decide: DecideFn = async (snapshot: MarketSnapshot): Promise<Decision> => {
    const response = await fetch(`${endpoint}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: renderSnapshot(snapshot) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`adapter ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as DecideResponse;
    requests++;
    totalLatency += data.latency_ms ?? 0;

    // Re-parse rather than trusting the server's field: one parser, one behaviour, so a
    // drift between the Python and TypeScript rules cannot silently change results.
    const action = parseAction(data.raw ?? '');

    if (action === null) {
      parseFailures++;
      return {
        action: 'FLAT',
        confidence: 0,
        rationale: `unparseable: ${(data.raw ?? '').slice(0, 120)}`,
        generation,
        model,
      };
    }

    const terse = data.raw.trim().replace(/[^A-Za-z]/g, '').toUpperCase() === action;
    return {
      action,
      confidence: terse ? 1 : 0.6,
      rationale: data.raw.trim().slice(0, 200),
      generation,
      model,
    };
  };

  return {
    decide,
    parseFailureRate: () => (requests === 0 ? 0 : parseFailures / requests),
    requests: () => requests,
    meanLatencyMs: () => (requests === 0 ? 0 : totalLatency / requests),
  };
}
