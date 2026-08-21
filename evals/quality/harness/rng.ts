/**
 * Seeded randomness for the eval suite.
 *
 * Anything the harness chooses — which bars get re-probed, what a control brain answers —
 * is drawn from here, so two runs of the same brain over the same window differ only by
 * the brain's own sampling. Without that, a shifting probe set would be indistinguishable
 * from a brain that became less consistent.
 */

/** mulberry32. Same generator as `test/helpers.ts`, so fixtures behave identically. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks `want` items without replacement.
 *
 * Partial Fisher-Yates rather than sort-by-random: the latter's result depends on the
 * sort implementation's tie handling, which is not something a seed can pin down.
 */
export function sample<T>(items: readonly T[], want: number, seed: number): T[] {
  const pool = [...items];
  const take = Math.min(want, pool.length);
  const rand = rng(seed);

  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    const a = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = a;
  }
  return pool.slice(0, take);
}
