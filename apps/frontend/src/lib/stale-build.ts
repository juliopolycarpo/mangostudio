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
