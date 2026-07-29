const GIT_PANEL_PREFS_KEY = 'mangostudio:git-panel-prefs';

export interface GitPanelPrefs {
  /** Passes `--prune` to fetch so deleted remote branches stop being listed. */
  readonly pruneOnFetch: boolean;
}

const DEFAULT_PREFS: GitPanelPrefs = { pruneOnFetch: true };

/**
 * Panel-wide preferences, shared by the overflow menu and the remote actions.
 * Not per chat: the same person wants the same fetch behavior in every
 * repository they open.
 */
export function readGitPanelPrefs(): GitPanelPrefs {
  try {
    const raw = window.localStorage.getItem(GIT_PANEL_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS;
    const pruneOnFetch = (parsed as Record<string, unknown>).pruneOnFetch;
    return { pruneOnFetch: typeof pruneOnFetch === 'boolean' ? pruneOnFetch : true };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeGitPanelPrefs(prefs: GitPanelPrefs): void {
  try {
    window.localStorage.setItem(GIT_PANEL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Panel preferences are best-effort when storage is unavailable.
  }
}
