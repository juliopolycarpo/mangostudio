import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { pinTokenizerClockPerTest } from '../../support/harness/pinned-tokenizer-clock';

const realNowBeforeFile = Date.now;

describe('pinTokenizerClockPerTest', () => {
  pinTokenizerClockPerTest();

  it('freezes Date.now inside a test, whatever the host speed', () => {
    const first = Date.now();
    const busyUntil = performance.now() + 5;
    while (performance.now() < busyUntil) {
      // Burn real time; a frozen clock must not move.
    }
    expect(Date.now(), 'Date.now() after 5 ms of real time').toBe(first);
    expect(first, 'frozen reading').toBe(0);
  });
});

describe('pinTokenizerClockPerTest after its tests', () => {
  let nowSeenAfterPinnedDescribe: typeof Date.now | undefined;
  beforeAll(() => {
    nowSeenAfterPinnedDescribe = Date.now;
  });
  afterAll(() => {
    Date.now = realNowBeforeFile;
  });

  it('puts the real Date.now back', () => {
    expect(nowSeenAfterPinnedDescribe, 'Date.now outside a pinned test').toBe(realNowBeforeFile);
  });
});
