import { afterEach, describe, expect, it } from 'bun:test';

import {
  type BuildProbe,
  createStaleBuildMonitor,
  probeBuildFreshness,
} from '../../../src/lib/stale-build';

const shellNaming = (entry: string) =>
  `<!doctype html><script src="/config.js"></script><script type="module" crossorigin src="${entry}"></script>`;

/** A tab that loaded `loaded`, talking to a hub whose shell is `shell` (or unreachable). */
function fakeBuildProbe(loaded: string | null, shell: string | Error): BuildProbe {
  return {
    loadedEntryScript: () => loaded,
    fetchShell: () => (shell instanceof Error ? Promise.reject(shell) : Promise.resolve(shell)),
  };
}

describe('probeBuildFreshness', () => {
  it('is stale when the hub now names a different entry bundle than the tab loaded', async () => {
    const probe = fakeBuildProbe(
      '/assets/main-aaaa1111.js',
      shellNaming('/assets/main-bbbb2222.js')
    );
    expect(await probeBuildFreshness(probe)).toBe('stale');
  });

  it('is current when the hub still serves the entry the tab loaded', async () => {
    const probe = fakeBuildProbe(
      '/assets/main-aaaa1111.js',
      shellNaming('/assets/main-aaaa1111.js')
    );
    expect(await probeBuildFreshness(probe)).toBe('current');
  });

  it('is unknown when the hub cannot be reached, because then a retry may succeed', async () => {
    const probe = fakeBuildProbe('/assets/main-aaaa1111.js', new TypeError('Failed to fetch'));
    expect(await probeBuildFreshness(probe)).toBe('unknown');
  });

  it('is current on a page with no hashed entry, as under the dev server', async () => {
    const probe = fakeBuildProbe(null, shellNaming('/assets/main-bbbb2222.js'));
    expect(await probeBuildFreshness(probe)).toBe('current');
  });

  it('is unknown when the shell names no entry bundle, rather than guessing', async () => {
    const probe = fakeBuildProbe('/assets/main-aaaa1111.js', '<html>maintenance page</html>');
    expect(await probeBuildFreshness(probe)).toBe('unknown');
  });
});

describe('the browser probe', () => {
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '/assets/main-aaaa1111.js';
  const realFetch = globalThis.fetch;

  afterEach(() => {
    script.remove();
    globalThis.fetch = realFetch;
  });

  it('puts a timeout on the shell fetch, and reads a timeout as unknown', async () => {
    document.head.append(script);
    const signals: (AbortSignal | null | undefined)[] = [];
    const timedOutFetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    };
    globalThis.fetch = timedOutFetch as unknown as typeof fetch;

    expect(await probeBuildFreshness()).toBe('unknown');

    expect(signals, 'signals passed to fetch').toHaveLength(1);
    expect(
      signals[0] instanceof AbortSignal && !signals[0].aborted,
      `expected a live AbortSignal on the shell fetch | received: ${signals[0] === undefined || signals[0] === null ? String(signals[0]) : `aborted=${signals[0].aborted}`}`
    ).toBe(true);
  });
});

/** A hub whose shell fetches are counted, and whose current entry the test can change. */
class FakeHub {
  shellFetches = 0;
  /** False while the hub is down, as during an upgrade restart. */
  reachable = true;
  shellEntry: string;
  constructor(
    readonly loaded: string,
    shellEntry: string
  ) {
    this.shellEntry = shellEntry;
  }
  probe(): BuildProbe {
    return {
      loadedEntryScript: () => this.loaded,
      fetchShell: () => {
        this.shellFetches += 1;
        return this.reachable
          ? Promise.resolve(shellNaming(this.shellEntry))
          : Promise.reject(new TypeError('Failed to fetch'));
      },
    };
  }
}

class ManualClock {
  time = 1_000;
  readonly now = (): number => this.time;
}

describe('createStaleBuildMonitor', () => {
  it('shares one probe among concurrent callers', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());

    const answers = await Promise.all([monitor.check(), monitor.check(), monitor.check()]);

    expect(answers).toEqual([false, false, false]);
    expect(hub.shellFetches, 'index.html fetches for three callers').toBe(1);
  });

  it('reuses a current answer for 30 s, then probes again', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const clock = new ManualClock();
    const monitor = createStaleBuildMonitor(hub.probe(), clock.now);

    await monitor.check();
    clock.time += 29_000;
    await monitor.check();
    expect(hub.shellFetches, 'fetches inside 30 s').toBe(1);

    clock.time += 2_000;
    await monitor.check();
    expect(hub.shellFetches, 'fetches after 30 s').toBe(2);
  });

  it('forgets a current answer when a chunk loads, so the next failure probes again', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());

    await monitor.check();
    monitor.noteChunkLoaded();
    hub.shellEntry = '/assets/main-bbbb2222.js';

    expect(await monitor.check()).toBe(true);
    expect(hub.shellFetches).toBe(2);
  });

  it('does not reuse an unknown answer: the next failure probes again', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());
    hub.reachable = false;

    expect(await monitor.check()).toBe(false);
    hub.reachable = true;
    hub.shellEntry = '/assets/main-bbbb2222.js';

    expect(await monitor.check(), 'answer once the hub is back with a new build').toBe(true);
    expect(hub.shellFetches, 'fetches: one while down, one after').toBe(2);
  });

  it('probes again when the hub becomes reachable after an unknown answer', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());
    let notifications = 0;
    monitor.subscribe(() => {
      notifications += 1;
    });
    hub.reachable = false;
    await monitor.check();
    hub.reachable = true;
    hub.shellEntry = '/assets/main-bbbb2222.js';

    monitor.noteHubReachable();
    await monitor.check();

    expect(monitor.isStale(), 'stale after the hub came back with a new build').toBe(true);
    expect(notifications, 'subscriber notifications').toBe(1);
    expect(hub.shellFetches, 'fetches: one while down, one on reconnect').toBe(2);
  });

  it('does nothing when the hub becomes reachable and the last answer was definite', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());
    await monitor.check();

    monitor.noteHubReachable();
    await monitor.check();

    expect(hub.shellFetches, 'fetches after a current answer and a reconnect').toBe(1);
  });

  it('does not start a second probe when reachable is reported twice', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());
    hub.reachable = false;
    await monitor.check();
    hub.reachable = true;

    monitor.noteHubReachable();
    monitor.noteHubReachable();
    await monitor.check();

    expect(hub.shellFetches, 'fetches: one while down, one for two reachability reports').toBe(2);
  });

  it('keeps stale for good, notifies subscribers once, and never probes again', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-bbbb2222.js');
    const monitor = createStaleBuildMonitor(hub.probe());
    let notifications = 0;
    monitor.subscribe(() => {
      notifications += 1;
    });
    expect(monitor.isStale()).toBe(false);

    expect(await monitor.check()).toBe(true);
    monitor.noteChunkLoaded();
    expect(await monitor.check()).toBe(true);

    expect(monitor.isStale()).toBe(true);
    expect(notifications, 'subscriber notifications').toBe(1);
    expect(hub.shellFetches, 'index.html fetches once stale').toBe(1);
  });

  it('stops notifying a subscriber that unsubscribed', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-bbbb2222.js');
    const monitor = createStaleBuildMonitor(hub.probe());
    let notifications = 0;
    const unsubscribe = monitor.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();

    await monitor.check();

    expect(notifications).toBe(0);
  });
});
