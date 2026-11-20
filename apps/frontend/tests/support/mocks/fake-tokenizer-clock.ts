/**
 * Clocks for the tokenizer's cooperative time limit. The grammar reads `Date.now()` between
 * regex matches and stops once the elapsed time passes `tokenizeTimeLimit`, so a test decides
 * whether a call stops by what the clock says, without waiting on a real compile.
 */

/** Time never passes: a call can only finish. */
export function frozenTokenizerClock(): number {
  return 0;
}

/**
 * Reads 0 for its first few calls, then a second later: the tokenizer starts, then finds the
 * limit passed and stops before the line ends. A new instance restarts the count, so each
 * stopping call needs its own.
 */
export class StoppingTokenizerClock {
  private reads = 0;
  now = (): number => (++this.reads <= 4 ? 0 : 1_000);
}

/**
 * A second later on every read: the first line the tokenizer reads the clock for has started at
 * one reading and finds the limit passed at the next, whatever the line holds. A call that
 * tokenizes any line stops; `StoppingTokenizerClock` stops only a line with enough matches.
 */
export class EveryLineStopsTokenizerClock {
  private reads = 0;
  now = (): number => this.reads++ * 1_000;
}

/**
 * Passes the limit during the first of the two passes `includeExplanation` makes over a line
 * (`tokenizeLine`, which stops early and returns coarse tokens) and then stands still, so the
 * second pass (`tokenizeLine2`) finishes with finer ones. The shiki zip of the two then runs out
 * of explanation tokens: `undefined is not an object (evaluating 'tokenWithScopes.startIndex')`.
 * A slow CI machine under coverage produces the same split by chance.
 */
export class FirstPassStopsTokenizerClock {
  private reads = 0;
  now = (): number => (this.reads++ < 2 ? this.reads * 1_000 : 2_001);
}

/** Runs `run` with `Date.now` replaced by `now`, and puts the real clock back afterwards. */
export function withTokenizerClock<T>(now: () => number, run: () => T): T {
  const realNow = Date.now;
  try {
    Date.now = now;
    return run();
  } finally {
    Date.now = realNow;
  }
}

/** `withTokenizerClock` for a callback that awaits: the clock stays replaced until it settles. */
export async function withTokenizerClockAsync<T>(
  now: () => number,
  run: () => Promise<T>
): Promise<T> {
  const realNow = Date.now;
  try {
    Date.now = now;
    return await run();
  } finally {
    Date.now = realNow;
  }
}
