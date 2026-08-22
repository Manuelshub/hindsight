/**
 * The exact text a brain is served, and the wire vocabulary it answers in.
 *
 * Training and serving must agree token for token. Generation 1 proved what happens when
 * they do not: the trainer discarded `instruction`, applied its own wrapper, and the model
 * never saw the 67-token system prompt or the "Action:" suffix that serving injects. It
 * learned one prompt and was asked another.
 *
 * `FLAT` is not used on the wire. It tokenises as FL+AT, two tokens against single tokens
 * for LONG and SHORT, which biases greedy decoding against it before training starts.
 * `NONE` is a single token in both bare and space-prefixed form. The domain type stays
 * `FLAT` everywhere: only the word the model reads and writes changes.
 */
import type { Side } from '../../../schemas/index.js';
import { renderSnapshot } from '../../market/src/indicators.js';
import type { MarketSnapshot } from '../../../schemas/index.js';

/**
 * Bumped whenever the served prompt text or the wire vocabulary changes.
 *
 * Recorded in `configHash` alongside FEATURE_VERSION and RENDERER_VERSION. Without it, a
 * prompt rewrite would change what the model saw while leaving the on-chain commitment
 * identical, and two generations that read different instructions would look comparable.
 */
export const PROMPT_VERSION = 2;

/** Wire word for each domain action. */
export const WIRE: Record<Side, WireWord> = { LONG: 'LONG', SHORT: 'SHORT', FLAT: 'NONE' };

/** Wire word back to domain action. */
export const FROM_WIRE: Record<string, Side> = { LONG: 'LONG', SHORT: 'SHORT', NONE: 'FLAT' };

export const WIRE_WORDS = ['LONG', 'SHORT', 'NONE'] as const;

/** What the model actually reads and writes. Distinct from the domain `Side`. */
export type WireWord = (typeof WIRE_WORDS)[number];

export const SYSTEM_PROMPT = [
  'You are a disciplined systematic trading agent.',
  'Given a market snapshot, reply with exactly one word: LONG, SHORT, or NONE.',
  'Use LONG if you expect price to rise, SHORT if you expect it to fall,',
  'and NONE when neither direction is clearly favoured.',
  'Reply with the single word only. No punctuation, no explanation.',
].join('\n');

/**
 * The complete prompt body a brain receives, minus any chat wrapper.
 *
 * Training examples embed this verbatim so the trained token sequence contains the served
 * one no matter what wrapper the provider applies on top.
 */
export function servingPrompt(snapshot: MarketSnapshot): string {
  return `${SYSTEM_PROMPT}\n\n${renderSnapshot(snapshot)}\n\nAction:`;
}
