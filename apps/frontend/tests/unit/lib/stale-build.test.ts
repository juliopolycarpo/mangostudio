import { afterEach, describe, expect, it } from 'bun:test';

import {
  browserBuildProbe,
  type BuildProbe,
  createStaleBuildMonitor,
  probeBuildFreshness,
  SHELL_PROBE_TIMEOUT_MS,
} from '../../../src/lib/stale-build';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../support/harness/timers';

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

  it('gives up on a hub that accepts the request and never answers, then probes again next time', async () => {
    document.head.append(script);
    const requests: string[] = [];
    /** A hub mid-restart: takes the request, says nothing, and only the abort ends it. */
    const silentHubFetch = (input: unknown, init?: RequestInit): Promise<Response> => {
      requests.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        );
      });
    };
    globalThis.fetch = silentHubFetch as unknown as typeof fetch;
    useFakeTimers();
    try {
      const monitor = createStaleBuildMonitor(browserBuildProbe());
      const first = monitor.check();
      let settled = false;
      void first.then(() => {
        settled = true;
      });

      await advanceTimersByTimeAsync(SHELL_PROBE_TIMEOUT_MS - 1);
      expect(settled, 'probe settled before the timeout').toBe(false);
      await advanceTimersByTimeAsync(1);

      expect(await first, 'answer of a probe that timed out').toBe(false);
      expect(settled, 'probe settled after the timeout').toBe(true);
      void monitor.check();
      expect(requests, 'shell requests after a timed-out probe and a second check()').toHaveLength(
        2
      );
    } finally {
      await restoreRealTimers();
    }
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
