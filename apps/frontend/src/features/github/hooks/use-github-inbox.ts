import type { GithubInboxResponse } from '@mangostudio/shared/github';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApp } from '@/lib/app-context';

import { githubInboxQueryOptions } from '../queries';
import { useForceRefresh } from './use-force-refresh';

export interface GithubInbox {
  readonly query: UseQueryResult<GithubInboxResponse, Error>;
  /** Re-reads the inbox past the hub's cache, for exactly this one request. */
  readonly refresh: () => void;
}

/**
 * The review queue for the machine the given chat runs on.
 *
 * The source chat's own record first, and the shell's current environment only
 * as a fallback — the same resolution `useIssueToNewChat` uses, since a chat
 * pinned to WSL/SSH/a container has `gh` credentials that live on that machine,
 * not on the hub's. Owned by the panel, not the inbox section, so the panel can
 * tell a signed-out `gh` apart from an empty queue before it draws either half
 * of itself, and the section's rows and the panel's refresh read one cache entry.
 *
 * @example
 * const inbox = useGithubInbox(chatId);
 * <GithubRefreshButton onRefresh={inbox.refresh} refreshing={inbox.query.isFetching} />
 */
export function useGithubInbox(chatId: string): GithubInbox {
  const { chats, currentEnvironmentId } = useApp();
  const environmentId =
    chats.find((chat) => chat.id === chatId)?.environmentId ?? currentEnvironmentId ?? undefined;
  const forceRefresh = useForceRefresh();
  const query = useQuery(githubInboxQueryOptions(environmentId, forceRefresh.read));

  return { query, refresh: () => void forceRefresh.trigger(query.refetch) };
}
