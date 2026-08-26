import { GIT_SCOPES, type GitScope, gitTopic } from '@mangostudio/shared/realtime';
import { getRealtimeBus } from '../../../services/realtime/realtime-bus';

const FILE_MUTATION_SCOPES = ['state', 'diffs'] as const satisfies readonly GitScope[];
const TURN_COMPLETION_SCOPES = [
  'state',
  'diffs',
  'history',
  'github',
] as const satisfies readonly GitScope[];
const FILE_MUTATION_DEBOUNCE_MS = 500;
const pendingFileMutationInvalidations = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Server-side counterpart to the frontend write invalidation map. Keeping the
 * operation names aligned makes each successful mutation publish only the cache
 * slices it can actually change.
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
  stashDrop: ['stashes'],
  createBranch: ['state', 'branches'],
  deleteBranch: ['branches'],
  renameBranch: ['state', 'branches', 'github'],
  switchBranch: ['state', 'branches', 'history', 'diffs', 'github'],
  checkoutRemote: ['state', 'branches', 'history', 'diffs', 'github'],
  fetch: ['state', 'branches', 'github'],
  pull: ['state', 'branches', 'history', 'commits', 'diffs', 'github'],
  push: ['state', 'branches', 'github'],
  // A worktree add or remove leaves the calling chat's own tree untouched, so
  // neither publishes `state`. Both ride the `branches` scope rather than a
  // scope of their own: which branch is checked out where is exactly what they
  // change, and the frontend hangs its worktree cache off the same scope.
  worktreeAdd: ['branches'],
  worktreeRemove: ['branches'],
} as const satisfies Record<string, readonly GitScope[]>;

export type GitWriteOperation = keyof typeof gitWriteScopes;

export interface GitInvalidationTarget {
  readonly userId: string;
  readonly chatId: string;
  readonly environmentId: string;
}

function invalidationKey(target: GitInvalidationTarget): string {
  return `${target.userId}\0${target.chatId}`;
}

function publishGitInvalidation(target: GitInvalidationTarget, scopes: readonly GitScope[]): void {
  getRealtimeBus().publish(target.userId, {
    type: 'invalidate',
    topic: gitTopic(target.chatId),
    scopes: [...scopes],
  });
}

/** Publishes only after the owning application mutation has succeeded. */
export function publishGitWriteInvalidation(
  target: GitInvalidationTarget,
  operation: GitWriteOperation
): void {
  publishGitInvalidation(target, gitWriteScopes[operation]);
}

/** Coalesces a burst of checkpointed tool writes into one trailing refresh. */
export function scheduleGitFileMutationInvalidation(target: GitInvalidationTarget): void {
  const key = invalidationKey(target);
  const pending = pendingFileMutationInvalidations.get(key);
  if (pending) clearTimeout(pending);

  pendingFileMutationInvalidations.set(
    key,
    setTimeout(() => {
      pendingFileMutationInvalidations.delete(key);
      publishGitInvalidation(target, FILE_MUTATION_SCOPES);
    }, FILE_MUTATION_DEBOUNCE_MS)
  );
}

/**
 * A completed turn refreshes the broader state. If it finishes inside the file
 * debounce window, this superset replaces the still-pending narrow refresh.
 */
export function publishGitTurnCompletionInvalidation(target: GitInvalidationTarget): void {
  const key = invalidationKey(target);
  const pending = pendingFileMutationInvalidations.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingFileMutationInvalidations.delete(key);
  }
  publishGitInvalidation(target, TURN_COMPLETION_SCOPES);
}

/** Clears process-local debounce state between integration tests. */
export function resetGitRealtimeInvalidationsForTests(): void {
  for (const pending of pendingFileMutationInvalidations.values()) {
    clearTimeout(pending);
  }
  pendingFileMutationInvalidations.clear();
}
