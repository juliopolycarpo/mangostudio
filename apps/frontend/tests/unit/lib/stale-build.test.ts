import { describe, expect, it } from 'bun:test';

import {
  type BuildProbe,
  createStaleBuildMonitor,
  isRunningStaleBuild,
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

describe('isRunningStaleBuild', () => {
  it('is true when the hub now names a different entry bundle than the tab loaded', async () => {
    const probe = fakeBuildProbe(
      '/assets/main-aaaa1111.js',
      shellNaming('/assets/main-bbbb2222.js')
    );
    expect(await isRunningStaleBuild(probe)).toBe(true);
  });

  it('is false when the hub still serves the entry the tab loaded', async () => {
    const probe = fakeBuildProbe(
      '/assets/main-aaaa1111.js',
      shellNaming('/assets/main-aaaa1111.js')
    );
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });

  it('is false when the hub cannot be reached, because then a retry may succeed', async () => {
    const probe = fakeBuildProbe('/assets/main-aaaa1111.js', new TypeError('Failed to fetch'));
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });

  it('is false on a page with no hashed entry, as under the dev server', async () => {
    const probe = fakeBuildProbe(null, shellNaming('/assets/main-bbbb2222.js'));
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });

  it('is false when the shell names no entry bundle, rather than guessing', async () => {
    const probe = fakeBuildProbe('/assets/main-aaaa1111.js', '<html>maintenance page</html>');
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });
});

/** A hub whose shell fetches are counted, and whose current entry the test can change. */
class FakeHub {
  shellFetches = 0;
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
        return Promise.resolve(shellNaming(this.shellEntry));
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

  it('reuses a not-stale answer for 30 s, then probes again', async () => {
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

  it('forgets a not-stale answer when a chunk loads, so the next failure probes again', async () => {
    const hub = new FakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');
    const monitor = createStaleBuildMonitor(hub.probe());

    await monitor.check();
    monitor.noteChunkLoaded();
    hub.shellEntry = '/assets/main-bbbb2222.js';

    expect(await monitor.check()).toBe(true);
    expect(hub.shellFetches).toBe(2);
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
