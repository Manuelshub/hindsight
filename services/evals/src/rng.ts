/**
 * Seeded sampling for the eval suite.
 *
 * Anything the harness chooses — which bars get re-probed, what a control brain answers —
 * is drawn from here, so two runs of the same brain over the same window differ only by
 * the brain's own sampling. Without that, a shifting probe set would be indistinguishable
 * from a brain that became less consistent.
 */
import { rng } from './project.js';

export { rng };

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
