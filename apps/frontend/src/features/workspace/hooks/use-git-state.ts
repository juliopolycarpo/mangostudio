import {
  type AddWorktreeBody,
  type CommitResponse,
  type DiscardPathsBody,
  type GenerateCommitMessageResponse,
  type GitBatchStateResponse,
  type GitBranchesResponse,
  type GitCommitDetailsResponse,
  type GitDiffResponse,
  type GitHeadMessageResponse,
  type GitHistoryResponse,
  type GitPushBody,
  type GitRepoState,
  type GitStatus,
  type GitSummary,
  type GitWorktreeListResponse,
  type InitRepoResponse,
  type RemoveWorktreeBody,
  type StashListResponse,
} from '@mangostudio/shared/git';
import { GIT_SCOPES, type GitScope, gitTopic } from '@mangostudio/shared/realtime';
import {
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { githubKeys } from '@/features/github/queries';
import { client } from '@/lib/api-client';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { ApiError } from '@/lib/utils';

import { createGitSummaryBatcher, type GitSummaryBatcher } from './git-summary-batcher';
import { githubContextKeys } from './use-github-context';

const gitStateKeys = {
  all: ['git-state'] as const,
  detail: (chatId: string) => [...gitStateKeys.all, chatId] as const,
};

// One entry per chat, not per request: a badge keeps its cached answer when the
// rows around it change, and a git write reaches it by chat id.
const gitSummaryKeys = {
  all: ['git-summary'] as const,
  detail: (chatId: string) => [...gitSummaryKeys.all, chatId] as const,
};

const gitStashKeys = {
  all: ['git-stashes'] as const,
  detail: (chatId: string) => [...gitStashKeys.all, chatId] as const,
};

const gitHeadMessageKeys = {
  all: ['git-head-message'] as const,
  detail: (chatId: string) => [...gitHeadMessageKeys.all, chatId] as const,
};

const gitBranchKeys = {
  all: ['git-branches'] as const,
  detail: (chatId: string) => [...gitBranchKeys.all, chatId] as const,
};

const gitHistoryKeys = {
  all: ['git-history'] as const,
  detail: (chatId: string) => [...gitHistoryKeys.all, chatId] as const,
};

const gitCommitKeys = {
  all: ['git-commit'] as const,
  detail: (chatId: string, hash: string) => [...gitCommitKeys.all, chatId, hash] as const,
};

const gitWorktreeKeys = {
  all: ['git-worktrees'] as const,
  detail: (chatId: string) => [...gitWorktreeKeys.all, chatId] as const,
};

const gitDiffKeys = {
  all: ['git-diff'] as const,
  detail: (chatId: string, input: GitDiffInput) =>
    [...gitDiffKeys.all, chatId, input.path, input.staged ?? false, input.commit ?? null] as const,
};

/**
 * Declarative invalidation map: each write states what it can change so a
 * single-file stage click does not refetch history or every cached commit.
 *
 * Scope names come from the shared realtime contract, which is also what the
 * server sends on a `git:<chatId>` invalidation.
 */
export const gitWriteScopes = {
  init: GIT_SCOPES,
  stage: ['state', 'diffs'],
  unstage: ['state', 'diffs'],
  discard: ['state', 'diffs'],
  commit: ['state', 'history', 'commits', 'branches', 'diffs', 'github'],
  stashSave: ['state', 'stashes', 'diffs'],
  stashPop: ['state', 'stashes', 'diffs'],
  stashApply: ['state', 'stashes', 'diffs'],
  // Dropping only removes a stack entry; the worktree and its diffs are untouched.
  stashDrop: ['stashes'],
  // createBranch runs `git switch -c` at the current HEAD — log is unchanged.
  createBranch: ['state', 'branches'],
  deleteBranch: ['branches'],
  renameBranch: ['state', 'branches', 'github'],
  switchBranch: ['state', 'branches', 'history', 'diffs', 'github'],
  checkoutRemote: ['state', 'branches', 'history', 'diffs', 'github'],
  fetch: ['state', 'branches', 'github'],
  pull: ['state', 'branches', 'history', 'commits', 'diffs', 'github'],
  push: ['state', 'branches', 'github'],
  // Adding or removing a worktree leaves this chat's own tree alone, so neither
  // publishes `state`. Both ride `branches`, which is the scope the worktree
  // cache hangs off — see `invalidateGitScopes`.
  worktreeAdd: ['branches'],
  worktreeRemove: ['branches'],
} as const satisfies Record<string, readonly GitScope[]>;

type GitPathSelection = { paths: string[] } | { all: true };
export type GitDiscardSelection = Pick<DiscardPathsBody, 'paths' | 'mode'>;
interface CommitInput {
  title: string;
  body?: string;
  amend?: boolean;
}
interface GenerateCommitMessageInput {
  model?: string;
}
interface StashSaveInput {
  message?: string;
  includeUntracked?: boolean;
}
interface StashPopInput {
  index?: number;
}
interface RenameBranchInput {
  name: string;
  newName: string;
}
interface DeleteBranchInput {
  name: string;
  force?: boolean;
}
export type AddWorktreeInput = Omit<AddWorktreeBody, 'chatId'>;
export type RemoveWorktreeInput = Omit<RemoveWorktreeBody, 'chatId'>;
export interface GitDiffInput {
  path: string;
  staged?: boolean;
  commit?: string;
}

function gitStateQueryOptions(chatId: string) {
  return queryOptions({
    queryKey: gitStateKeys.detail(chatId),
    queryFn: async () => {
      const { data, error } = await client.api.git.state.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    refetchOnWindowFocus: true,
  });
}

export function invalidateGitState(queryClient: QueryClient, chatId: string): Promise<void> {
  // Delegating keeps every entry point into the state scope reaching the
  // chunk-keyed batched summaries too.
  return invalidateGitScopes(queryClient, chatId, ['state']);
}

/**
 * Every Git slice for one chat, for the one thing no `git:<chatId>` event
 * announces: the chat being repointed at another folder or another machine.
 *
 * Nothing in these keys but the chat id changes when that happens, so branches,
 * history and cached diffs all still describe the repository the chat has just
 * stopped pointing at.
 */
export function invalidateAllGitScopes(queryClient: QueryClient, chatId: string): Promise<void> {
  return invalidateGitScopes(queryClient, chatId, GIT_SCOPES);
}

/**
 * Refetches exactly the Git slices a write can have changed.
 *
 * Exported for writes that live outside this module but move the same refs —
 * `gh pr checkout` is one — so they can name their scopes from
 * {@link gitWriteScopes} instead of invalidating the whole query client.
 *
 * @example
 * await invalidateGitScopes(queryClient, chatId, gitWriteScopes.checkoutRemote);
 */
export async function invalidateGitScopes(
  queryClient: QueryClient,
  chatId: string,
  scopes: readonly GitScope[]
): Promise<void> {
  const keys: Record<GitScope, readonly unknown[]> = {
    state: gitStateKeys.detail(chatId),
    stashes: gitStashKeys.detail(chatId),
    branches: gitBranchKeys.detail(chatId),
    history: gitHistoryKeys.detail(chatId),
    commits: [...gitCommitKeys.all, chatId],
    diffs: [...gitDiffKeys.all, chatId],
    github: [...githubContextKeys.all, chatId],
  };
  await Promise.all([
    ...scopes.map((scope) => queryClient.invalidateQueries({ queryKey: keys[scope] })),
    // The list badges are a slimmer read of the same state; invalidating a chat
    // that is on screen refetches its badge, and one scrolled away only goes
    // stale, to refresh when its row returns.
    ...(scopes.includes('state')
      ? [queryClient.invalidateQueries({ queryKey: gitSummaryKeys.detail(chatId) })]
      : []),
    // Worktrees share the `branches` scope rather than owning one: which branch
    // is checked out where is exactly what a worktree write changes, and the
    // server publishes the same scope for both.
    ...(scopes.includes('branches')
      ? [queryClient.invalidateQueries({ queryKey: gitWorktreeKeys.detail(chatId) })]
      : []),
    // `githubContextKeys` above is the small branch-scoped context widget;
    // the PR/issue/check/thread reads the GitHub panel itself renders live
    // under `githubKeys`, unscoped by chat because that is how every other
    // caller already invalidates them (see GithubRepoSection's own checkout
    // handler). Without this, a same-client write still looks right — it
    // invalidates `githubKeys` explicitly alongside this call — but a second
    // mounted client reachable only through this `git:<chatId>` event would
    // keep showing the pre-write panel state indefinitely.
    ...(scopes.includes('github')
      ? [queryClient.invalidateQueries({ queryKey: githubKeys.all })]
      : []),
  ]);
}

async function fetchGitSummaryChunk(
  chatIds: readonly string[]
): Promise<Record<string, GitSummary>> {
  const { data, error } = await client.api.git.state.batch.post({ chatIds: [...chatIds] });
  if (error) throw new ApiError(error.value);
  return (data as GitBatchStateResponse).states;
}

const gitSummaryBatchers = new WeakMap<QueryClient, GitSummaryBatcher>();

/**
 * One batcher per query client, shared by every surface that shows badges, so
 * the sidebar and a dashboard card that mount in the same turn leave as one
 * request rather than one each.
 */
function gitSummaryBatcherFor(queryClient: QueryClient): GitSummaryBatcher {
  let batcher = gitSummaryBatchers.get(queryClient);
  if (!batcher) {
    batcher = createGitSummaryBatcher(fetchGitSummaryChunk);
    gitSummaryBatchers.set(queryClient, batcher);
  }
  return batcher;
}

/**
 * Slim git badges for the chats a surface is showing, fetched through the
 * batched endpoint so N rows cost one request per
 * `GIT_BATCH_STATE_MAX_CHAT_IDS` ids instead of an N+1 fan-out of
 * `GET /git/state`.
 *
 * Pass the rows on screen, not the account: every id costs a `git status` on
 * the host. Each chat is cached on its own, so ids that leave the list keep their
 * badge for the cache's lifetime and a list that shifts by a few rows asks only
 * about the new ones. Reads that start together share a request.
 *
 * A missing key means the query is still loading; `null` means the server has
 * no answer for that chat (no workdir, not a repo, or not this user's).
 *
 * `includeCached` also returns every other badge the cache still holds. A list
 * that moves its window reports it after a short settle, and a row that comes
 * back into view in that gap would otherwise show no badge until the window
 * catches up, a flicker for an answer already in hand. Those entries are not
 * observed, so they are as old as when they were last on screen; they refresh
 * when their ids are asked for again.
 *
 * @example
 * const summaries = useBatchedGitSummaries(idsInView, { includeCached: true });
 */
export function useBatchedGitSummaries(
  chatIds: readonly string[],
  { includeCached = false }: { includeCached?: boolean } = {}
): Record<string, GitSummary | null> {
  const queryClient = useQueryClient();
  const uniqueChatIds = useUniqueChatIds(chatIds);
  const batcher = gitSummaryBatcherFor(queryClient);

  const queries = useMemo(
    () =>
      uniqueChatIds.map((chatId) => ({
        queryKey: gitSummaryKeys.detail(chatId),
        queryFn: () => batcher.load(chatId),
        staleTime: 30_000,
        // Only mounted queries refetch on focus, so this covers exactly the
        // rows on screen. List badges have no realtime topic of their own;
        // focus is their freshness signal even though the query client default
        // disables it.
        refetchOnWindowFocus: true,
      })),
    [uniqueChatIds, batcher]
  );

  // Stable identity plus a plain object: `useQueries` only structurally shares
  // the combined result (skipping re-renders on untouched chats) when the
  // combine function is referentially stable and the result is a plain
  // array/object — a Map or an inline arrow would defeat both layers.
  const combine = useCallback(
    (results: UseQueryResult<GitSummary | null>[]) => {
      const summaries: Record<string, GitSummary | null> = {};
      if (includeCached) {
        for (const query of queryClient.getQueryCache().findAll({ queryKey: gitSummaryKeys.all })) {
          const cached = query.state.data as GitSummary | null | undefined;
          const chatId = query.queryKey[1];
          if (cached !== undefined && typeof chatId === 'string') summaries[chatId] = cached;
        }
      }
      results.forEach((result, index) => {
        // A settled read answers even when it failed: the server omits chats it
        // has no answer for, and an errored request has none at all, so both
        // degrade to a resolved `null` rather than a permanent spinner.
        if (result.isPending) return;
        const chatId = uniqueChatIds[index];
        if (chatId !== undefined) summaries[chatId] = result.data ?? null;
      });
      return summaries;
    },
    [uniqueChatIds, includeCached, queryClient]
  );

  return useQueries({ queries, combine });
}

/**
 * The ids without duplicates, in the caller's order.
 *
 * The memo keys on the array's identity, which is why the callers memoize the
 * list they pass: the shell re-renders once per streamed token, and the dedupe
 * would otherwise run over the whole list on every one of them. A caller that
 * does pass a fresh array pays that pass but nothing worse — the record this
 * hook returns still holds its reference through `useQueries` structural
 * sharing.
 */
function useUniqueChatIds(chatIds: readonly string[]): string[] {
  return useMemo(() => [...new Set(chatIds)], [chatIds]);
}

export function useGitState(chatId: string) {
  return useQuery(gitStateQueryOptions(chatId));
}

/**
 * Keeps every mounted Git panel fresh across tabs and server-side workspace
 * changes. A subscription acknowledgement invalidates every slice because
 * events may have been missed while the socket was disconnected.
 */
export function useGitRealtimeInvalidation(chatId: string): void {
  const queryClient = useQueryClient();

  useRealtimeInvalidation(gitTopic(chatId), 'git-state', (signal) => {
    if (signal.type === 'subscribed') {
      return invalidateGitScopes(queryClient, chatId, GIT_SCOPES);
    }
    // The realtime client dispatches only exact-topic matches to this listener,
    // so a git subscription has already narrowed the validated event's scopes.
    return invalidateGitScopes(
      queryClient,
      chatId,
      (signal.message.scopes as readonly GitScope[] | undefined) ?? GIT_SCOPES
    );
  });
}

export function useInitRepo(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<InitRepoResponse> => {
      const { data, error } = await client.api.git.init.post({ chatId });
      if (error) throw new ApiError(error.value);
      return data as InitRepoResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.init),
  });
}

export function useStagePaths(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (selection: GitPathSelection): Promise<GitStatus> => {
      const { data, error } = await client.api.git.stage.post({ chatId, ...selection });
      if (error) throw new ApiError(error.value);
      return data as GitStatus;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stage),
  });
}

export function useUnstagePaths(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (selection: GitPathSelection): Promise<GitStatus> => {
      const { data, error } = await client.api.git.unstage.post({ chatId, ...selection });
      if (error) throw new ApiError(error.value);
      return data as GitStatus;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.unstage),
  });
}

export function useDiscardPaths(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GitDiscardSelection): Promise<GitStatus> => {
      const { data, error } = await client.api.git.discard.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitStatus;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.discard),
  });
}

export function useCommit(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CommitInput): Promise<CommitResponse> => {
      const { data, error } = await client.api.git.commit.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as CommitResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.commit),
  });
}

export function useGenerateCommitMessage(chatId: string) {
  return useMutation({
    mutationFn: async (
      input: GenerateCommitMessageInput = {}
    ): Promise<GenerateCommitMessageResponse> => {
      const { data, error } = await client.api.git['commit-message'].post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GenerateCommitMessageResponse;
    },
  });
}

export function useGitStashes(chatId: string) {
  return useQuery({
    queryKey: gitStashKeys.detail(chatId),
    queryFn: async (): Promise<StashListResponse> => {
      const { data, error } = await client.api.git.stashes.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as StashListResponse;
    },
  });
}

export function useStashSave(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashSaveInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.stash.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashSave),
  });
}

export function useStashPop(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashPopInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.stash.pop.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashPop),
  });
}

export function useStashApply(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashPopInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.stash.apply.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashApply),
  });
}

export function useStashDrop(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StashPopInput): Promise<StashListResponse> => {
      const { data, error } = await client.api.git.stash.drop.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as StashListResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.stashDrop),
  });
}

export function useGitBranches(chatId: string) {
  return useQuery({
    queryKey: gitBranchKeys.detail(chatId),
    queryFn: async (): Promise<GitBranchesResponse> => {
      const { data, error } = await client.api.git.branches.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitBranchesResponse;
    },
  });
}

export function useSwitchBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches.switch.post({ chatId, name });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.switchBranch),
  });
}

export function useCreateBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches.post({ chatId, name });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.createBranch),
  });
}

export function useDeleteBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteBranchInput): Promise<GitBranchesResponse> => {
      const { data, error } = await client.api.git.branches.delete({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitBranchesResponse;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.deleteBranch),
  });
}

export function useRenameBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RenameBranchInput): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches.rename.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.renameBranch),
  });
}

export function useCheckoutRemoteBranch(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (remoteRef: string): Promise<GitRepoState> => {
      const { data, error } = await client.api.git.branches['checkout-remote'].post({
        chatId,
        remoteRef,
      });
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes.checkoutRemote),
  });
}

export function useGitHistory(chatId: string) {
  return useInfiniteQuery({
    queryKey: gitHistoryKeys.detail(chatId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<GitHistoryResponse> => {
      const query = pageParam ? { chatId, cursor: pageParam } : { chatId };
      const { data, error } = await client.api.git.history.get({ query });
      if (error) throw new ApiError(error.value);
      return data as GitHistoryResponse;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useGitCommit(chatId: string, hash: string | null) {
  return useQuery({
    queryKey: gitCommitKeys.detail(chatId, hash ?? ''),
    enabled: hash !== null,
    queryFn: async (): Promise<GitCommitDetailsResponse> => {
      if (!hash) throw new Error('A commit hash is required.');
      const { data, error } = await client.api.git.commit.get({ query: { chatId, hash } });
      if (error) throw new ApiError(error.value);
      return data as GitCommitDetailsResponse;
    },
  });
}

export function useGitDiff(chatId: string, input: GitDiffInput | null) {
  return useQuery({
    queryKey: gitDiffKeys.detail(chatId, input ?? { path: '' }),
    enabled: input !== null,
    queryFn: async (): Promise<GitDiffResponse> => {
      if (!input) throw new Error('A diff selection is required.');
      const { data, error } = await client.api.git.diff.get({
        query: { chatId, ...input },
      });
      if (error) throw new ApiError(error.value);
      return data as GitDiffResponse;
    },
  });
}

interface RemoteMutationInput {
  prune?: boolean;
  force?: GitPushBody['force'];
}

function useRemoteMutation(chatId: string, operation: 'fetch' | 'pull' | 'push') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RemoteMutationInput = {}): Promise<GitRepoState> => {
      const endpoint = client.api.git[operation];
      const body =
        operation === 'fetch'
          ? { chatId, prune: input.prune }
          : operation === 'push'
            ? { chatId, ...(input.force ? { force: input.force } : {}) }
            : { chatId };
      const { data, error } = await endpoint.post(body);
      if (error) throw new ApiError(error.value);
      return data as GitRepoState;
    },
    onSuccess: () => invalidateGitScopes(queryClient, chatId, gitWriteScopes[operation]),
  });
}

export function useGitFetch(chatId: string) {
  return useRemoteMutation(chatId, 'fetch');
}

export function useGitPull(chatId: string) {
  return useRemoteMutation(chatId, 'pull');
}

export function useGitPush(chatId: string) {
  return useRemoteMutation(chatId, 'push');
}

/**
 * The commit an amend would replace. Enabled only while amend mode is active so
 * the panel does not spawn a `git log` on every render of every chat.
 */
export function useGitHeadMessage(chatId: string, enabled: boolean) {
  const queryClient = useQueryClient();

  // Leaving amend mode discards the entry instead of parking it in the cache.
  // A commit, an amend, or a checkout moves HEAD without this query running, so
  // a retained success would prefill the form from a message that no longer
  // exists, and a retained failure would bounce the user straight back out of
  // amend mode before the retry it triggers could resolve.
  useEffect(() => {
    if (enabled) return;
    queryClient.removeQueries({ queryKey: gitHeadMessageKeys.detail(chatId) });
  }, [enabled, chatId, queryClient]);

  return useQuery({
    queryKey: gitHeadMessageKeys.detail(chatId),
    enabled,
    queryFn: async (): Promise<GitHeadMessageResponse> => {
      const { data, error } = await client.api.git['head-message'].get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitHeadMessageResponse;
    },
  });
}

/**
 * Every worktree of the chat's repository.
 *
 * No polling: worktrees change through this panel or through a terminal, and
 * the panel's manual refresh plus the `branches` invalidation cover both. The
 * stale window matches the rest of the panel's reads.
 *
 * `enabled` is for a caller that holds the query before it knows there is a
 * repository to ask about (the panel header, which refreshes it).
 *
 * @example
 * const { data } = useGitWorktrees(chatId); // data?.worktrees
 */
export function useGitWorktrees(chatId: string, enabled = true) {
  return useQuery({
    queryKey: gitWorktreeKeys.detail(chatId),
    enabled,
    queryFn: async (): Promise<GitWorktreeListResponse> => {
      const { data, error } = await client.api.git.worktrees.get({ query: { chatId } });
      if (error) throw new ApiError(error.value);
      return data as GitWorktreeListResponse;
    },
    staleTime: 30_000,
  });
}

/**
 * Both worktree writes answer with the repository's refreshed list — the server
 * re-reads it inside the mutation lock — so the response is seeded into the
 * cache before the scopes are invalidated. The invalidation still revalidates
 * in the background, but the rows update from the answer the write already
 * carried instead of showing the pre-write list until a second
 * `git worktree list` returns from the runtime.
 */
function settleWorktreeWrite(
  queryClient: QueryClient,
  chatId: string,
  worktrees: GitWorktreeListResponse,
  scopes: readonly GitScope[]
): Promise<void> {
  queryClient.setQueryData(gitWorktreeKeys.detail(chatId), worktrees);
  return invalidateGitScopes(queryClient, chatId, scopes);
}

/** Creates a worktree; resolves with the repository's refreshed worktree list. */
export function useAddWorktree(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddWorktreeInput): Promise<GitWorktreeListResponse> => {
      const { data, error } = await client.api.git.worktrees.post({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitWorktreeListResponse;
    },
    onSuccess: (worktrees) =>
      settleWorktreeWrite(queryClient, chatId, worktrees, gitWriteScopes.worktreeAdd),
  });
}

/** Removes a worktree; resolves with the repository's refreshed worktree list. */
export function useRemoveWorktree(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RemoveWorktreeInput): Promise<GitWorktreeListResponse> => {
      const { data, error } = await client.api.git.worktrees.delete({ chatId, ...input });
      if (error) throw new ApiError(error.value);
      return data as GitWorktreeListResponse;
    },
    onSuccess: (worktrees) =>
      settleWorktreeWrite(queryClient, chatId, worktrees, gitWriteScopes.worktreeRemove),
  });
}
