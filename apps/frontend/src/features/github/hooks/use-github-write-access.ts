import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { readGithubPanelPrefs } from '../lib/github-panel-prefs';
import { type WriteAccess, writeAccessOf } from '../lib/write-access';
import { githubPrsQueryOptions } from '../queries';

/**
 * What the chat's pull request list has already said about writing, without
 * asking it.
 *
 * For callers outside the GitHub panel, such as the command palette, that want
 * the panel's own `canMutate` answer. The observer is disabled, so it reads the
 * query cache the panel fills and follows its updates but never starts a
 * `gh pr list` itself: a palette opening must not spawn a subprocess per chat
 * just to decide whether one row is worth showing. The consequence is that the
 * answer is `pending` until the panel has read the list once in this session.
 *
 * The filter only picks which cache entry to read, and `canMutate` is the same
 * in every one of them, so the panel's remembered filter is as good as any.
 *
 * @example
 * const writeAccess = useCachedGithubWriteAccess(currentChatId);
 * if (writeAccess === 'refused') hideWriteRows();
 */
export function useCachedGithubWriteAccess(chatId: string | null): WriteAccess {
  const [filter] = useState(() => readGithubPanelPrefs().prFilter);
  const query = useQuery({
    ...githubPrsQueryOptions(chatId ?? '', filter),
    enabled: false,
  });
  return chatId === null ? 'pending' : writeAccessOf(query);
}
