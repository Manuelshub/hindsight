/**
 * Marker for behaviour that is specified and tested but not yet built.
 *
 * Every stub in this codebase throws this rather than returning a plausible-looking
 * default, so an unimplemented path fails loudly in a test instead of quietly producing
 * a number someone might believe.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}
