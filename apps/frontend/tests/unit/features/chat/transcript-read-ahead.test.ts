/**
 * The decisions behind transcript read-ahead: how many older pages are kept
 * loaded, when one more is wanted, and the idle gate in front of every fetch.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../../support/harness/timers';
import { FakeIdleScheduler } from '../../../support/mocks/fake-idle-scheduler';

const {
  READ_AHEAD_IDLE_PAGES,
  READ_AHEAD_SCROLL_PAGES,
  READ_AHEAD_VIEWPORTS_ABOVE,
  dropBackgroundRun,
  olderPagesAbove,
  registerBackgroundRun,
  scheduleIdle,
  takeBackgroundRun,
  wantsOlderPage,
} = await import('../../../../src/features/chat/transcript-read-ahead');

const VIEWPORT = 800;
/** Far below the top of what is loaded: no "nearing the top" in these. */
const FAR_FROM_TOP = 50_000;

function position(firstVisibleIndex: number, offsetPx = FAR_FROM_TOP) {
  return { firstVisibleIndex, offsetPx, viewportPx: VIEWPORT };
}

/** Fails as `expected older page wanted: yes | received: no (<case>)`. */
function expectWanted(
  expected: boolean,
  input: Parameters<typeof wantsOlderPage>[0],
  label: string
) {
  const received = wantsOlderPage(input);
  expect(
    received ? 'yes' : 'no',
    `expected older page wanted: ${expected ? 'yes' : 'no'} | received: ${received ? 'yes' : 'no'} (${label})`
  ).toBe(expected ? 'yes' : 'no');
}

describe('window sizes', () => {
  it('buffers one page when idle and two while scrolling', () => {
    expect(`idle window: ${READ_AHEAD_IDLE_PAGES}`).toBe('idle window: 1');
    expect(`scroll window: ${READ_AHEAD_SCROLL_PAGES}`).toBe('scroll window: 2');
    expect(`viewports above: ${READ_AHEAD_VIEWPORTS_ABOVE}`).toBe('viewports above: 2');
  });
});

describe('olderPagesAbove', () => {
  it('counts the pages wholly above the page the reader is in', () => {
    const sizes = [50, 50, 50];
    expect(`pages above row 10: ${olderPagesAbove(sizes, 10)}`).toBe('pages above row 10: 0');
    expect(`pages above row 60: ${olderPagesAbove(sizes, 60)}`).toBe('pages above row 60: 1');
    expect(`pages above row 149: ${olderPagesAbove(sizes, 149)}`).toBe('pages above row 149: 2');
  });

  it('puts a position past the end in the newest page', () => {
    expect(`pages above row 500: ${olderPagesAbove([50, 50], 500)}`).toBe('pages above row 500: 1');
  });

  it('is zero for no pages at all', () => {
    expect(`pages above: ${olderPagesAbove([], 0)}`).toBe('pages above: 0');
  });
});

describe('wantsOlderPage while idle', () => {
  it('wants the first older page when only the newest is loaded', () => {
    expectWanted(
      true,
      { hasMore: true, scrolling: false, pageSizes: [50], position: position(10) },
      'one page loaded'
    );
  });

  it('wants nothing once the idle window is full', () => {
    expectWanted(
      false,
      { hasMore: true, scrolling: false, pageSizes: [50, 50], position: position(60, 0) },
      'idle, one older page buffered, even at the very top'
    );
  });

  it('wants nothing when the newest page is the whole chat', () => {
    expectWanted(
      false,
      { hasMore: false, scrolling: false, pageSizes: [30], position: position(0) },
      'nothing older exists'
    );
  });

  it('wants nothing before any page has loaded', () => {
    expectWanted(
      false,
      { hasMore: true, scrolling: false, pageSizes: [], position: position(0) },
      'no pages'
    );
  });
});

describe('wantsOlderPage while the reader scrolls up', () => {
  it('stays in the idle window while the reader is in the newest page', () => {
    expectWanted(
      false,
      { hasMore: true, scrolling: true, pageSizes: [50, 50], position: position(80) },
      'scrolling inside the newest page, far from the top'
    );
  });

  it('wants the next page once the reader crosses into an older page', () => {
    expectWanted(
      true,
      { hasMore: true, scrolling: true, pageSizes: [50, 50], position: position(40) },
      'crossed into the older page'
    );
  });

  it('keeps wanting pages until two lie above the reader', () => {
    const inFirst = (sizes: number[], row: number) => ({
      hasMore: true,
      scrolling: true,
      pageSizes: sizes,
      position: position(row),
    });
    expectWanted(true, inFirst([50, 50, 50], 60), 'one page above the reader');
    expectWanted(false, inFirst([50, 50, 50, 50], 110), 'two pages above the reader');
  });

  it('wants the next page when the reader is near the top of what is loaded', () => {
    expectWanted(
      true,
      {
        hasMore: true,
        scrolling: true,
        pageSizes: [50, 50],
        position: position(80, READ_AHEAD_VIEWPORTS_ABOVE * VIEWPORT),
      },
      'within two viewports of the top, in the newest page'
    );
  });

  it('does not want more when nothing older exists', () => {
    expectWanted(
      false,
      { hasMore: false, scrolling: true, pageSizes: [50, 50], position: position(0, 0) },
      'the oldest message is loaded'
    );
  });
});

describe('scheduleIdle', () => {
  afterEach(() => restoreRealTimers());

  it('runs the callback when the browser is idle, asking for the given timeout', async () => {
    const idle = new FakeIdleScheduler().install();
    try {
      let ran = 0;
      scheduleIdle(() => {
        ran++;
      }, 1_234);
      expect(`ran before idle: ${ran}`).toBe('ran before idle: 0');
      expect(`requested timeout: ${idle.timeouts[0]}`).toBe('requested timeout: 1234');

      await idle.runIdle();
      expect(`ran after idle: ${ran}`).toBe('ran after idle: 1');
    } finally {
      idle.restore();
    }
  });

  it('never runs a callback that was cancelled', async () => {
    const idle = new FakeIdleScheduler().install();
    try {
      let ran = 0;
      const cancel = scheduleIdle(() => {
        ran++;
      }, 1_000);
      cancel();
      await idle.runIdle();
      expect(`ran after cancel: ${ran}`).toBe('ran after cancel: 0');
    } finally {
      idle.restore();
    }
  });

  it('falls back to a timer where there is no idle callback', async () => {
    useFakeTimers();
    let ran = 0;
    scheduleIdle(() => {
      ran++;
    }, 2_000);
    expect(`ran at once: ${ran}`).toBe('ran at once: 0');

    await advanceTimersByTimeAsync(250);
    expect(`ran after the fallback delay: ${ran}`).toBe('ran after the fallback delay: 1');
  });

  it('cancels the fallback timer too', async () => {
    useFakeTimers();
    let ran = 0;
    const cancel = scheduleIdle(() => {
      ran++;
    }, 2_000);
    cancel();

    await advanceTimersByTimeAsync(5_000);
    expect(`ran after cancel: ${ran}`).toBe('ran after cancel: 0');
  });
});

describe('background runs', () => {
  it('hands a registered run to the fetch that claims it, once', () => {
    const query = {};
    const run = { controller: new AbortController(), failed: false };
    registerBackgroundRun(query, run);

    expect(takeBackgroundRun(query)).toBe(run);
    expect(takeBackgroundRun(query)).toBeUndefined();
  });

  it('does not hand a run to a different query', () => {
    registerBackgroundRun({}, { controller: new AbortController(), failed: false });
    expect(takeBackgroundRun({})).toBeUndefined();
  });

  it('forgets a run that never claimed its fetch', () => {
    const query = {};
    const run = { controller: new AbortController(), failed: false };
    registerBackgroundRun(query, run);
    dropBackgroundRun(query, run);

    expect(takeBackgroundRun(query)).toBeUndefined();
  });

  it('does not drop a newer run when an older one is dropped', () => {
    const query = {};
    const older = { controller: new AbortController(), failed: false };
    const newer = { controller: new AbortController(), failed: false };
    registerBackgroundRun(query, newer);
    dropBackgroundRun(query, older);

    expect(takeBackgroundRun(query)).toBe(newer);
  });
});
