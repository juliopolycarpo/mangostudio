/**
 * The account's folders, assembled from the sessions that point at them.
 *
 * There is no Workspace entity behind this and there is deliberately not going
 * to be one: a "workspace" is every chat that shares a `workdir`, plus the
 * folders the picker remembers but nobody has opened a session in yet. The
 * grouping is composition over data the app already holds, so a folder appears
 * the moment a chat points at it and disappears when the last one stops.
 *
 * Order is the chat list's own order — the server returns it `updatedAt desc`,
 * so first appearance is last activity. Nothing here re-sorts by a timestamp,
 * because the one that matters (a folder's most recent session) is already the
 * reason the list arrived in this order.
 */

import type { Chat } from '@mangostudio/shared';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { runnerKey } from '@/features/sidebar/lib/runner-badge';
import { workdirLabel } from '@/lib/paths';

export interface WorkspaceGroup {
  /** The exact `chat.workdir` string, and the group's identity. */
  readonly workdir: string;
  /** Folder name for display, falling back to the path when it has no segment. */
  readonly name: string;
  /**
   * The chat whose Git summary stands for the whole folder — the most recent
   * one. Null for a remembered folder with no session yet.
   *
   * One representative rather than every chat in the group: they share a
   * worktree, so N sessions on one folder report one branch and one dirty
   * count between them, and reading N of them is N readings of one answer.
   */
  readonly representativeChatId: string | null;
  /** Title of the representative, so "continue" can name what it resumes. */
  readonly representativeTitle: string | null;
  readonly sessionCount: number;
  /** Distinct harnesses used in this folder, most recently active first. */
  readonly runners: readonly ChatRunnerConfiguration[];
}

export interface WorkspaceGroups {
  readonly groups: readonly WorkspaceGroup[];
  /** Folders past the limit, so the grid can say how much it is not showing. */
  readonly overflowCount: number;
}

/** More than this and the grid stops being a glance; the rest are counted. */
export const WORKSPACE_GROUP_LIMIT = 6;

interface MutableGroup {
  workdir: string;
  representativeChatId: string | null;
  representativeTitle: string | null;
  sessionCount: number;
  runners: ChatRunnerConfiguration[];
}

function addRunner(group: MutableGroup, runner: ChatRunnerConfiguration): void {
  const key = runnerKey(runner);
  if (group.runners.some((existing) => runnerKey(existing) === key)) return;
  group.runners.push(runner);
}

function seal(group: MutableGroup): WorkspaceGroup {
  return {
    workdir: group.workdir,
    // `workdirLabel` never returns null for a non-empty path; the fallback is
    // for the empty string, which is not a folder anything can be grouped by.
    name: workdirLabel(group.workdir) ?? group.workdir,
    representativeChatId: group.representativeChatId,
    representativeTitle: group.representativeTitle,
    sessionCount: group.sessionCount,
    runners: group.runners,
  };
}

/**
 * Folders with sessions first, in last-activity order, then folders the picker
 * remembers that nobody has a session in — in the order settings stores them,
 * which is most-recently-chosen first.
 *
 * Workdirs are compared as exact strings. Chats and the recent list are both
 * written by the same picker, so a normalization step here would only invent
 * disagreements between two values that came from one source.
 *
 * // Usage: groupChatsByWorkdir(chats, workspaceSettings.recentWorkdirs)
 */
export function groupChatsByWorkdir(
  chats: readonly Chat[],
  recentWorkdirs: readonly string[]
): WorkspaceGroups {
  const byWorkdir = new Map<string, MutableGroup>();

  for (const chat of chats) {
    if (!chat.workdir) continue;
    const existing = byWorkdir.get(chat.workdir);
    if (existing) {
      existing.sessionCount += 1;
      addRunner(existing, chat.runner);
      continue;
    }
    // First chat seen for this folder is its most recent one, so it is both the
    // representative and the head of the runner list.
    const group: MutableGroup = {
      workdir: chat.workdir,
      representativeChatId: chat.id,
      representativeTitle: chat.title,
      sessionCount: 1,
      runners: [chat.runner],
    };
    byWorkdir.set(chat.workdir, group);
  }

  for (const workdir of recentWorkdirs) {
    if (!workdir || byWorkdir.has(workdir)) continue;
    byWorkdir.set(workdir, {
      workdir,
      representativeChatId: null,
      representativeTitle: null,
      sessionCount: 0,
      runners: [],
    });
  }

  // A `Map` iterates in insertion order, so chat groups come out ahead of the
  // remembered-only ones without a second pass to keep the two lists in step.
  const groups = [...byWorkdir.values()].map(seal);
  return {
    groups: groups.slice(0, WORKSPACE_GROUP_LIMIT),
    overflowCount: Math.max(0, groups.length - WORKSPACE_GROUP_LIMIT),
  };
}
