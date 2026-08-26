/**
 * What the GitHub panel remembers between visits.
 *
 * Panel-wide rather than per chat, on the same reasoning as
 * `git-panel-prefs.ts`: somebody who only ever wants their own pull requests
 * wants that in every repository they open, and a filter that resets per
 * conversation is a filter they re-pick all day.
 *
 * The inbox is collapsible because it is the one section that is *not* about
 * the repository on screen. Somebody with an empty review queue should be able
 * to fold it away permanently rather than scroll past it.
 */

import type { GithubIssueFilter, GithubPrFilter } from '@mangostudio/shared/github';

const GITHUB_PANEL_PREFS_KEY = 'mangostudio:github-panel-prefs';

export interface GithubPanelPrefs {
  readonly prFilter: GithubPrFilter;
  readonly issueFilter: GithubIssueFilter;
  readonly inboxCollapsed: boolean;
  readonly repoCollapsed: boolean;
}

const DEFAULT_PREFS: GithubPanelPrefs = {
  prFilter: 'open',
  issueFilter: 'open',
  inboxCollapsed: false,
  repoCollapsed: false,
};

/**
 * `all` is deliberately absent: it is the branch list's annotation filter, not
 * a view somebody browses, and restoring it as a remembered choice would show
 * a panel full of long-merged pull requests on open.
 */
const PR_FILTERS: readonly GithubPrFilter[] = ['open', 'mine', 'review-requested'];
const ISSUE_FILTERS: readonly GithubIssueFilter[] = ['open', 'assigned', 'mine'];

/**
 * Reads the remembered panel preferences, falling back per field.
 *
 * @example
 * const { prFilter } = readGithubPanelPrefs(); // 'mine'
 */
export function readGithubPanelPrefs(): GithubPanelPrefs {
  try {
    const raw = window.localStorage.getItem(GITHUB_PANEL_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS;
    return fromRecord(parsed as Record<string, unknown>);
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeGithubPanelPrefs(prefs: GithubPanelPrefs): void {
  try {
    window.localStorage.setItem(GITHUB_PANEL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Panel preferences are best-effort when storage is unavailable.
  }
}

function fromRecord(record: Record<string, unknown>): GithubPanelPrefs {
  return {
    prFilter: oneOf(record.prFilter, PR_FILTERS, DEFAULT_PREFS.prFilter),
    issueFilter: oneOf(record.issueFilter, ISSUE_FILTERS, DEFAULT_PREFS.issueFilter),
    inboxCollapsed: record.inboxCollapsed === true,
    repoCollapsed: record.repoCollapsed === true,
  };
}

/** Storage is user-writable, so a value that is not a member falls back. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
