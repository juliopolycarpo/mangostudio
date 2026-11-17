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
