/**
 * What `probeBuildFreshness` reads from the page and the hub. Injected so a
 * test can stage "the hub was upgraded" without a second build.
 */
export interface BuildProbe {
  /** The `src` of the entry script this tab loaded, or `null` when there is none (dev server, tests). */
  readonly loadedEntryScript: () => string | null;
  /** The hub's current `index.html`, fetched past any cache. Rejects when the hub cannot be reached in time. */
  readonly fetchShell: () => Promise<string>;
}

/** How long the shell probe waits for the hub; a hub mid-restart can accept a connection and say nothing. */
const SHELL_PROBE_TIMEOUT_MS = 5_000;

/** The content-hashed entry bundle `index.html` points at. */
const ENTRY_SCRIPT_PATTERN = /\/assets\/main-[\w-]+\.js/;

function browserBuildProbe(): BuildProbe {
  return {
    loadedEntryScript: () => {
      for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="module"]')) {
        const match = ENTRY_SCRIPT_PATTERN.exec(script.getAttribute('src') ?? '');
        if (match) return match[0];
      }
      return null;
    },
    fetchShell: async () => {
      const response = await fetch('/index.html', {
        cache: 'no-store',
        signal: AbortSignal.timeout(SHELL_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GET /index.html answered ${response.status}`);
      return response.text();
    },
  };
}

/**
 * What a probe found out. `unknown` is a real answer, not a missing one: it
 * means the hub could not say, which is not a reason to stop retrying and not a
 * reason to believe the tab is current.
 */
export type BuildFreshness = 'stale' | 'current' | 'unknown';

/**
 * Whether the hub now serves a different build than this tab is running.
 *
 * Chunk names carry a content hash and the hub keeps only the current build's
 * files, so after an upgrade under an open tab the names this tab asks for
 * answer 404 for good: asking again cannot work, only loading the new
 * `index.html` can. A failed `import()` does not say why it failed (offline,
 * a 404 and a script error read alike in every browser), so this compares the
 * entry bundle the tab loaded with the one the hub's `index.html` names now.
 *
 * - `stale`: the shell names another entry bundle.
 * - `current`: it names the one this tab loaded, or the page has no hashed
 *   entry at all (the dev server), so there is nothing to be stale against.
 * - `unknown`: the hub could not be reached in time, or answered with a shell
 *   that names no entry bundle. Mid-upgrade the hub is down for seconds, then
 *   serves the new build, so this must not be remembered as "current".
 *
 * Never reloads anything itself, so it cannot loop.
 *
 * @example
 * if ((await probeBuildFreshness()) === 'stale') offerReloadOnly();
 */
export async function probeBuildFreshness(
  probe: BuildProbe = browserBuildProbe()
): Promise<BuildFreshness> {
  const loaded = probe.loadedEntryScript();
  if (loaded === null) return 'current';
  try {
    const current = ENTRY_SCRIPT_PATTERN.exec(await probe.fetchShell())?.[0];
    if (current === undefined) return 'unknown';
    return current === loaded ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}

/** How long a "current" answer is reused before the next failure asks the hub again. */
const CURRENT_FRESH_MS = 30_000;

export interface StaleBuildMonitor {
  /**
   * Whether the hub now serves a newer build than this tab. One probe is shared
   * by every caller: a page with several failing surfaces, or a failed Retry
   * after a failed Retry, fetches `index.html` once, not once per panel.
   */
  check(): Promise<boolean>;
  /** The last answer, synchronously: `true` once a probe found the build stale. */
  isStale(): boolean;
  subscribe(listener: () => void): () => void;
  /**
   * A lazy chunk arrived, so the hub is serving what this tab asks for.
   * Forgets a remembered "current", so the next failure probes again.
   */
  noteChunkLoaded(): void;
  /**
   * The hub answered something (a realtime reconnect, the browser coming back
   * online). Probes now when the last probe could not reach it, so a tab that
   * has no Retry to press, such as one showing only messages, still learns that
   * the hub came back with a new build. Does nothing otherwise.
   */
  noteHubReachable(): void;
}

/**
 * Shares one stale-build probe among every surface that can fail on a chunk.
 *
 * "Stale" is sticky: the hub has the new files and this tab's names are gone for
 * good, so it stays true until the page reloads and the monitor starts over.
 * "Current" is reused for 30 s or until a chunk loads, whichever comes first.
 * "Unknown" is never reused: the next failure probes again, and so does the hub
 * becoming reachable.
 */
export function createStaleBuildMonitor(
  probe: BuildProbe,
  now: () => number = () => Date.now()
): StaleBuildMonitor {
  let stale = false;
  let shared: {
    readonly promise: Promise<boolean>;
    settledAt: number | null;
    result: BuildFreshness | null;
  } | null = null;
  const listeners = new Set<() => void>();

  function startProbe(): Promise<boolean> {
    const entry: NonNullable<typeof shared> = {
      promise: probeBuildFreshness(probe).then((freshness) => {
        entry.settledAt = now();
        entry.result = freshness;
        if (freshness === 'stale' && !stale) {
          stale = true;
          for (const listener of listeners) listener();
        }
        return freshness === 'stale';
      }),
      settledAt: null,
      result: null,
    };
    shared = entry;
    return entry.promise;
  }

  return {
    check() {
      if (stale) return Promise.resolve(true);
      // An unknown answer is not reusable, and an in-flight probe is (it has no answer yet).
      const reusable =
        shared !== null &&
        (shared.settledAt === null ||
          (shared.result === 'current' && now() - shared.settledAt < CURRENT_FRESH_MS));
      return reusable && shared ? shared.promise : startProbe();
    },
    isStale: () => stale,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    noteChunkLoaded() {
      if (shared?.result === 'current') shared = null;
    },
    noteHubReachable() {
      if (!stale && shared?.result === 'unknown') void startProbe();
    },
  };
}

/** The tab's monitor: reads the real document and asks the real hub. */
export const staleBuildMonitor: StaleBuildMonitor = createStaleBuildMonitor(browserBuildProbe());
