/**
 * "Start a new chat from this issue."
 *
 * The whole subtlety is which machine the new chat lands on. This repository
 * has already shipped that bug once: PR #939's review threads recorded that
 * "New chat here" created a chat on the *local* environment and then only
 * repointed its workdir, so the action failed on any workspace whose folder
 * does not exist locally. The fix is to resolve the environment from the source
 * — the chat whose panel the issue is being read in — and hand it to
 * `handleNewChatInWorkdir`, which already knows to bind the folder on that
 * machine rather than this one.
 */

import type { GithubIssueSummary } from '@mangostudio/shared/github';
import { useCallback } from 'react';
import { setComposerDraft } from '@/features/chat/lib/composer-draft-store';
import { useApp } from '@/lib/app-context';

/**
 * @param sourceChatId The chat the issue was read in. Its environment is the
 *   one the new chat must be bound to, because the repository folder is a path
 *   on that machine and nowhere else.
 * @param workdir The repository folder, as the source chat sees it.
 *
 * @example
 * const startChat = useIssueToNewChat(chatId, workdir);
 * await startChat(issue);
 */
export function useIssueToNewChat(
  sourceChatId: string,
  workdir: string | null
): (issue: GithubIssueSummary) => Promise<void> {
  const app = useApp();
  const { chats, currentEnvironmentId, handleNewChatInWorkdir } = app;

  return useCallback(
    async (issue: GithubIssueSummary) => {
      if (!workdir) return;
      // The source chat's own record first, and the shell's current environment
      // only as a fallback: they agree whenever the panel is open on the active
      // chat, and the record is the one that is still right if that ever stops
      // being true.
      const sourceChat = chats.find((chat) => chat.id === sourceChatId);
      const environmentId = sourceChat?.environmentId ?? currentEnvironmentId;
      if (!environmentId) return;

      const newChatId = await handleNewChatInWorkdir(workdir, environmentId);
      // Null means the binding failed and the chat was rolled back; the hook
      // that created it has already said so.
      if (!newChatId) return;
      setComposerDraft(newChatId, issueSeed(issue));
    },
    [chats, currentEnvironmentId, handleNewChatInWorkdir, sourceChatId, workdir]
  );
}

/**
 * The issue's title and its URL.
 *
 * Not the body, because there is none to seed: `GithubIssueSummary` is
 * `gh issue list --json number,title,state,labels,author,updatedAt,url,assignees`
 * and the contract has no issue-detail endpoint to ask for more. The URL is
 * carried instead of dropped for exactly that reason — an agent with `gh` can
 * read the full issue from it, which is a better answer than a second round
 * trip per row to prefetch bodies nobody may open.
 *
 * Deliberately not wrapped in an instruction: the person who clicked this is
 * about to read the composer and add what they actually want done. A generated
 * "please implement the following" would be one more line to delete, and the
 * seed is a starting point rather than a prompt.
 */
function issueSeed(issue: GithubIssueSummary): string {
  return `${issue.title}\n\n${issue.url}`;
}
