/**
 * The chats holding work that is not committed anywhere.
 *
 * The one thing a multi-harness cockpit actually loses track of: a branch left
 * dirty in a session three days ago, on a machine you are not looking at.
 * Built entirely from the batched summaries the sidebar already loads, so this
 * costs no request of its own.
 *
 * The chat the user is in right now is excluded — its state is already on
 * screen in the workspace card and the git rail beside it, and repeating it
 * here would push a genuinely forgotten chat off the list.
 */

import type { Chat } from '@mangostudio/shared';
import type { GitSummary } from '@mangostudio/shared/git';

interface UncommittedChat {
  readonly chatId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly changedFileCount: number;
  readonly ahead: number;
}

/** More than this and the card stops being a glance; the rest are counted. */
export const UNCOMMITTED_WORK_LIMIT = 4;

export interface UncommittedWork {
  readonly rows: readonly UncommittedChat[];
  /** Chats past the limit, so the card can say how much it is not showing. */
  readonly overflowCount: number;
}

/**
 * // Usage: uncommittedWork(chats, gitSummaries, currentChatId)
 */
export function uncommittedWork(
  chats: readonly Chat[],
  summaries: Readonly<Record<string, GitSummary | null>>,
  currentChatId: string | null
): UncommittedWork {
  const dirty: UncommittedChat[] = [];
  for (const chat of chats) {
    if (chat.id === currentChatId) continue;
    const summary = summaries[chat.id];
    if (!summary) continue;
    // Unpushed commits count too: work that exists only on this machine is
    // just as lost as work that exists only in the worktree, and a chat that
    // is clean-but-ahead is exactly the one nobody remembers to push.
    if (summary.changedFileCount === 0 && summary.ahead === 0) continue;
    dirty.push({
      chatId: chat.id,
      title: chat.title,
      branch: summary.branch ?? summary.detachedAt?.slice(0, 7) ?? null,
      changedFileCount: summary.changedFileCount,
      ahead: summary.ahead,
    });
  }

  // Most recently touched first — `chats` arrives in that order from the list
  // query, so the slice below keeps the rows the user is likeliest to want.
  return {
    rows: dirty.slice(0, UNCOMMITTED_WORK_LIMIT),
    overflowCount: Math.max(0, dirty.length - UNCOMMITTED_WORK_LIMIT),
  };
}
