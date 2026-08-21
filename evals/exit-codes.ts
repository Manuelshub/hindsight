/**
 * Exit codes and failure classification for the eval suite.
 *
 * The distinction that matters here is "the brain is bad" versus "the brain never got a
 * chance to answer". Both look like a failed eval from the outside, and collapsing them
 * into exit 1 means a CI run that goes red because a sidecar was down gets read as
 * evidence that a generation regressed. Every exit path below is a different sentence.
 */

export const EXIT = {
  /** Every threshold met. */
  OK: 0,
  /** Bad arguments, unknown brain, missing flag. Nothing was measured. */
  USAGE: 1,
  /** The eval ran to completion and the brain failed at least one threshold. */
  QUALITY: 2,
  /** Transport failed: server down, DNS, timeout, 5xx, rate limit. Says nothing about quality. */
  SERVICE: 3,
  /** The held-out window could not be proven disjoint from training data. Results discarded. */
  HOLDOUT: 4,
  /** The brain threw a non-transport error, i.e. it is broken rather than unskilled. */
  BRAIN_ERROR: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure that is the service's fault, not the brain's. Never reported as a quality result. */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/** A DecideFn that threw on a well-formed snapshot. Broken code, not a bad trader. */
export class BrainContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainContractError';
  }
}

/** The held-out window overlaps something the agent may have trained on. */
export class HoldoutIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutIntegrityError';
  }
}

/** Refusal to spend without an explicit opt-in, or an unusable invocation. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Matched against the error message rather than the error type because the failure
 * arrives from three different layers — undici, the 0G SDK, and our own fetch wrappers —
 * and none of them share a class. A false negative here is the expensive direction: it
 * would report a dead sidecar as a brain that answered FLAT to everything.
 */
const TRANSPORT_PATTERNS = [
  /econnrefused/i,
  /econnreset/i,
  /enotfound/i,
  /eai_again/i,
  /etimedout/i,
  /epipe/i,
  /fetch failed/i,
  /network/i,
  /socket/i,
  /timeout/i,
  /timed out/i,
  /aborted/i,
  /unreachable/i,
  /\b429\b/,
  /rate limit/i,
  /\b5\d\d\b/,
  /no model loaded/i,
];

export function isTransportError(err: unknown): boolean {
  if (err instanceof ServiceUnavailableError) return true;
  if (err instanceof BrainContractError) return false;

  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSPORT_PATTERNS.some((p) => p.test(message));
}

export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof HoldoutIntegrityError) return EXIT.HOLDOUT;
  if (err instanceof UsageError) return EXIT.USAGE;
  if (err instanceof ServiceUnavailableError) return EXIT.SERVICE;
  if (err instanceof BrainContractError) return EXIT.BRAIN_ERROR;
  return isTransportError(err) ? EXIT.SERVICE : EXIT.BRAIN_ERROR;
}
