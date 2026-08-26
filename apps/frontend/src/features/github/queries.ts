/**
 * GitHub panel query keys and options.
 *
 * `staleTime` matches the API's own 60s cache TTL rather than undercutting it.
 * A shorter one buys nothing: the hub answers a repeat read out of the same
 * cache entry, so the extra request costs a round trip and returns the byte the
 * client already had. Nothing here polls — every list is a live `gh` subprocess
 * on somebody's machine, and a side panel left open in a background tab has no
 * business spawning one a minute forever. Staleness is *rendered* from
 * `cachedAt` instead, so a stale list says so rather than pretending.
 */

import type {
  GithubInboxResponse,
  GithubIssueFilter,
  GithubIssuesResponse,
  GithubPrChecksResponse,
  GithubPrDetailResponse,
  GithubPrFilter,
  GithubPrsResponse,
  GithubPrThreadsResponse,
} from '@mangostudio/shared/github';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

/** The API caches GitHub reads for a minute; asking again sooner re-reads that cache. */
const GITHUB_STALE_TIME_MS = 60_000;

/**
 * Query keys for every GitHub read.
 *
 * Repo-scoped keys carry `chatId` rather than the repository, because the chat
 * is what picks both the workdir *and* the machine whose `gh` answers — two
 * chats on the same folder but different environments are two different reads.
 */
export const githubKeys = {
  all: ['github-panel'] as const,
  inbox: () => [...githubKeys.all, 'inbox'] as const,
  prs: (chatId: string, filter: GithubPrFilter) =>
    [...githubKeys.all, 'prs', chatId, filter] as const,
  issues: (chatId: string, filter: GithubIssueFilter) =>
    [...githubKeys.all, 'issues', chatId, filter] as const,
  pr: (chatId: string, number: number) => [...githubKeys.all, 'pr', chatId, number] as const,
  checks: (chatId: string, number: number) =>
    [...githubKeys.all, 'checks', chatId, number] as const,
  threads: (chatId: string, number: number) =>
    [...githubKeys.all, 'threads', chatId, number] as const,
};

/**
 * Pull requests waiting on this user's review, across every repository.
 *
 * No `environmentId`: absent means the hub's own machine, which is the one
 * whose `gh` credentials the panel can assume exist.
 *
 * @example
 * const inbox = useQuery(githubInboxQueryOptions());
 */
export function githubInboxQueryOptions() {
  return queryOptions({
    queryKey: githubKeys.inbox(),
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async (): Promise<GithubInboxResponse> => {
      const { data, error } = await client.api.github.inbox.get({ query: {} });
      if (error) throw new ApiError(error.value);
      return data as GithubInboxResponse;
    },
  });
}

/**
 * The active chat's repository pull requests under one filter.
 *
 * @example
 * useQuery(githubPrsQueryOptions('chat-1', 'open'));
 */
export function githubPrsQueryOptions(chatId: string, filter: GithubPrFilter) {
  return queryOptions({
    queryKey: githubKeys.prs(chatId, filter),
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async (): Promise<GithubPrsResponse> => {
      const { data, error } = await client.api.github.prs.get({ query: { chatId, filter } });
      if (error) throw new ApiError(error.value);
      return data as GithubPrsResponse;
    },
  });
}

/**
 * The active chat's repository issues under one filter.
 *
 * @example
 * useQuery(githubIssuesQueryOptions('chat-1', 'open'));
 */
export function githubIssuesQueryOptions(chatId: string, filter: GithubIssueFilter) {
  return queryOptions({
    queryKey: githubKeys.issues(chatId, filter),
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async (): Promise<GithubIssuesResponse> => {
      const { data, error } = await client.api.github.issues.get({ query: { chatId, filter } });
      if (error) throw new ApiError(error.value);
      return data as GithubIssuesResponse;
    },
  });
}

/**
 * One pull request in full: body, review verdict, merge state, diff stat.
 *
 * @example
 * useQuery(githubPrDetailQueryOptions('chat-1', 942));
 */
export function githubPrDetailQueryOptions(chatId: string, number: number) {
  return queryOptions({
    queryKey: githubKeys.pr(chatId, number),
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async (): Promise<GithubPrDetailResponse> => {
      const { data, error } = await client.api.github.pr.get({ query: { chatId, number } });
      if (error) throw new ApiError(error.value);
      return data as GithubPrDetailResponse;
    },
  });
}

/**
 * Every check run on one pull request, plus the server's reduction of them.
 *
 * @example
 * useQuery(githubPrChecksQueryOptions('chat-1', 942));
 */
export function githubPrChecksQueryOptions(chatId: string, number: number) {
  return queryOptions({
    queryKey: githubKeys.checks(chatId, number),
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async (): Promise<GithubPrChecksResponse> => {
      const { data, error } = await client.api.github.pr.checks.get({ query: { chatId, number } });
      if (error) throw new ApiError(error.value);
      return data as GithubPrChecksResponse;
    },
  });
}

/**
 * Inline review conversations on one pull request, resolved ones included —
 * the filtering to "still open" belongs to the composer formatter, which is
 * what needs it.
 *
 * @example
 * useQuery(githubPrThreadsQueryOptions('chat-1', 942));
 */
export function githubPrThreadsQueryOptions(chatId: string, number: number) {
  return queryOptions({
    queryKey: githubKeys.threads(chatId, number),
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async (): Promise<GithubPrThreadsResponse> => {
      const { data, error } = await client.api.github.pr['review-threads'].get({
        query: { chatId, number },
      });
      if (error) throw new ApiError(error.value);
      return data as GithubPrThreadsResponse;
    },
  });
}
