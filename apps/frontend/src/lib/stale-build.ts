/**
 * What `isRunningStaleBuild` reads from the page and the hub. Injected so a
 * test can stage "the hub was upgraded" without a second build.
 */
export interface BuildProbe {
  /** The `src` of the entry script this tab loaded, or `null` when there is none (dev server, tests). */
  readonly loadedEntryScript: () => string | null;
  /** The hub's current `index.html`, fetched past any cache. Rejects when the hub cannot be reached. */
  readonly fetchShell: () => Promise<string>;
}

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
      const response = await fetch('/index.html', { cache: 'no-store' });
      if (!response.ok) throw new Error(`GET /index.html answered ${response.status}`);
      return response.text();
    },
  };
}

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
 * Answers `false` whenever it cannot tell: the hub is unreachable (offline,
 * where retrying may well work), the page has no hashed entry (dev server), or
 * the shell does not name one. Never reloads anything itself, so it cannot
 * loop.
 *
 * @example
 * if (await isRunningStaleBuild()) offerReloadOnly();
 */
export async function isRunningStaleBuild(
  probe: BuildProbe = browserBuildProbe()
): Promise<boolean> {
  const loaded = probe.loadedEntryScript();
  if (loaded === null) return false;
  try {
    const current = ENTRY_SCRIPT_PATTERN.exec(await probe.fetchShell())?.[0];
    return current !== undefined && current !== loaded;
  } catch {
    return false;
  }
}

/** How long a "not stale" answer is reused before the next failure asks the hub again. */
const NOT_STALE_FRESH_MS = 30_000;

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
   * Forgets a remembered "not stale", so the next failure probes again.
   */
  noteChunkLoaded(): void;
}

/**
 * Shares one stale-build probe among every surface that can fail on a chunk.
 *
 * "Stale" is sticky: the hub has the new files and this tab's names are gone for
 * good, so it stays true until the page reloads and the monitor starts over.
 * "Not stale" is reused for 30 s or until a chunk loads, whichever comes first.
 */
export function createStaleBuildMonitor(
  probe: BuildProbe,
  now: () => number = () => Date.now()
): StaleBuildMonitor {
  let stale = false;
  let shared: { readonly promise: Promise<boolean>; settledAt: number | null } | null = null;
  const listeners = new Set<() => void>();

  function startProbe(): Promise<boolean> {
    const entry: NonNullable<typeof shared> = {
      promise: isRunningStaleBuild(probe).then((isStale) => {
        entry.settledAt = now();
        if (isStale && !stale) {
          stale = true;
          for (const listener of listeners) listener();
        }
        return isStale;
      }),
      settledAt: null,
    };
    shared = entry;
    return entry.promise;
  }

  return {
    check() {
      if (stale) return Promise.resolve(true);
      const reusable =
        shared !== null &&
        (shared.settledAt === null || now() - shared.settledAt < NOT_STALE_FRESH_MS);
      return reusable && shared ? shared.promise : startProbe();
    },
    isStale: () => stale,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    noteChunkLoaded() {
      if (shared?.settledAt != null) shared = null;
    },
  };
}

/** The tab's monitor: reads the real document and asks the real hub. */
export const staleBuildMonitor: StaleBuildMonitor = createStaleBuildMonitor(browserBuildProbe());
