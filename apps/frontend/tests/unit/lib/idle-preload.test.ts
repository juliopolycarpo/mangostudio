import { describe, expect, it } from 'bun:test';

import {
  IDLE_PRELOAD_FALLBACK_DELAY_MS,
  IDLE_PRELOAD_TIMEOUT_MS,
  type IdleEnvironment,
  preloadWhenIdle,
} from '../../../src/lib/idle-preload';

/** A browser with `requestIdleCallback`; the test decides when the idle moment arrives. */
function fakeIdleBrowser(options: { saveData?: boolean } = {}) {
  const idleRuns: (() => void)[] = [];
  const idleTimeouts: number[] = [];
  const cancelled: number[] = [];
  const environment: IdleEnvironment = {
    requestIdle: (run, { timeout }) => {
      idleRuns.push(run);
      idleTimeouts.push(timeout);
      return idleRuns.length;
    },
    cancelIdle: (handle) => cancelled.push(handle),
    setTimer: () => {
      throw new Error('expected requestIdleCallback to be used, received a timer');
    },
    clearTimer: () => undefined,
    saveData: () => options.saveData === true,
  };
  return { idleRuns, idleTimeouts, cancelled, environment };
}

/** Safari: no `requestIdleCallback`, so a timer stands in. */
function fakeTimerOnlyBrowser() {
  const timers: { run: () => void; delayMs: number }[] = [];
  const cleared: number[] = [];
  const environment: IdleEnvironment = {
    setTimer: (run, delayMs) => {
      timers.push({ run, delayMs });
      return timers.length;
    },
    clearTimer: (handle) => cleared.push(handle),
    saveData: () => false,
  };
  return { timers, cleared, environment };
}

describe('preloadWhenIdle', () => {
  it('starts nothing until the browser reports idle time, then starts every task', () => {
    const browser = fakeIdleBrowser();
    const started: string[] = [];

    preloadWhenIdle(
      [() => started.push('github'), () => started.push('todos')],
      browser.environment
    );
    expect(started).toEqual([]);

    browser.idleRuns[0]?.();
    expect(started).toEqual(['github', 'todos']);
  });

  it('gives the idle callback a timeout, so a busy page still preloads', () => {
    const browser = fakeIdleBrowser();
    preloadWhenIdle([() => undefined], browser.environment);
    expect(browser.idleTimeouts).toEqual([IDLE_PRELOAD_TIMEOUT_MS]);
  });

  it('does nothing when the person asked to save data', () => {
    const browser = fakeIdleBrowser({ saveData: true });
    preloadWhenIdle([() => undefined], browser.environment);
    expect(browser.idleRuns).toHaveLength(0);
  });

  it('does nothing for an empty task list', () => {
    const browser = fakeIdleBrowser();
    preloadWhenIdle([], browser.environment);
    expect(browser.idleRuns).toHaveLength(0);
  });

  it('cancels a pending idle start', () => {
    const browser = fakeIdleBrowser();
    const cancel = preloadWhenIdle([() => undefined], browser.environment);
    cancel();
    expect(browser.cancelled).toEqual([1]);
  });

  it('falls back to a timer where requestIdleCallback does not exist', () => {
    const browser = fakeTimerOnlyBrowser();
    const started: string[] = [];

    const cancel = preloadWhenIdle([() => started.push('github')], browser.environment);
    expect(browser.timers.map(({ delayMs }) => delayMs)).toEqual([IDLE_PRELOAD_FALLBACK_DELAY_MS]);

    browser.timers[0]?.run();
    expect(started).toEqual(['github']);

    cancel();
    expect(browser.cleared).toEqual([1]);
  });
});
