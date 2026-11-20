import { afterEach, beforeEach } from 'bun:test';

import { frozenTokenizerClock } from '../mocks/fake-tokenizer-clock';

/**
 * Freezes `Date.now` for every test of the calling file or `describe`, and puts the real clock
 * back after each one. The tokenizer stops a line once `Date.now` has moved 500 ms past its start,
 * so under a real clock a test of highlighting output depends on how fast the runner compiles a
 * grammar's regexes. A test that needs time to pass scripts its own clock inside the test.
 */
export function pinTokenizerClockPerTest(): void {
  let realNow: typeof Date.now | undefined;
  beforeEach(() => {
    realNow = Date.now;
    Date.now = frozenTokenizerClock;
  });
  afterEach(() => {
    if (realNow) Date.now = realNow;
    realNow = undefined;
  });
}
