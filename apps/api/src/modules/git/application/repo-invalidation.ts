/**
 * Tells every chat in one repository that a git or GitHub write happened.
 *
 * `git:<chatId>` reaches one chat, and the GitHub module widens that to chats
 * bound to the same workdir. This is the repository-wide counterpart: one frame
 * on `repo:<key>`, where the key names the repository's common directory, so a
 * chat in a linked worktree or a subdirectory, and the GitHub panel of any of
 * them, hear about a commit, a push or a pull request they did not make.
 *
 * It is published *alongside* the per-chat frame rather than instead of it. An
 * older tab never learns a repo key and keeps working off `git:<chatId>`, and a
 * newer tab that holds both coalesces the pair into one refetch.
 *
 * The bus is user-scoped, so the frame reaches only the sockets of the user
 * whose write it was; the key carries no authority of its own.
 */

import { type GitScope, repoTopic } from '@mangostudio/shared/realtime';

import { getDb } from '../../../db/database';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRealtimeBus } from '../../../services/realtime/realtime-bus';
import { getById } from '../../chats/infrastructure/chat-repository';
import type { GitRuntimeSelection } from '../infrastructure/git-cli';
import { resolveRepoKey } from './git-repo-key';
import { getRepoRoot } from './git-status-service';

const logger = createDiagnosticLogger('repo-invalidation');

export interface RepoInvalidationTarget {
  readonly userId: string;
  readonly environmentId: string;
  readonly workdir: string;
  /** The resolved worktree root, when the write already resolved one. */
  readonly root?: string;
}

export interface RepoInvalidationOptions {
  /** Injected so a test can name a repository without spawning Git. */
  readonly resolveRepoKeyForTarget?: (
    target: RepoInvalidationTarget
  ) => Promise<string | undefined>;
}

/** Resolves the root when the write did not, then the key. `undefined` when either fails. */
async function defaultResolveRepoKeyForTarget(
  target: RepoInvalidationTarget
): Promise<string | undefined> {
  const selection: GitRuntimeSelection = {
    userId: target.userId,
    environmentId: target.environmentId,
  };
  const root = target.root ?? (await getRepoRoot(target.workdir, undefined, selection));
  return root ? await resolveRepoKey(selection, root) : undefined;
}

/**
 * Publishes one `repo:<key>` frame carrying `scopes`. Resolves once the frame
 * went out or was skipped; never rejects, because the write it follows already
 * happened and a lookup failure must not read as a failed write.
 *
 * @example
 * void publishRepoInvalidation({ userId, environmentId, workdir }, ['state', 'github']);
 */
export async function publishRepoInvalidation(
  target: RepoInvalidationTarget,
  scopes: readonly GitScope[],
  options: RepoInvalidationOptions = {}
): Promise<void> {
  try {
    const resolve = options.resolveRepoKeyForTarget ?? defaultResolveRepoKeyForTarget;
    const repoKey = await resolve(target);
    if (!repoKey) return;
    getRealtimeBus().publish(target.userId, {
      type: 'invalidate',
      topic: repoTopic(repoKey),
      scopes: [...scopes],
    });
  } catch (error) {
    logger.error('repo_publish_failed', {
      environmentId: target.environmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * {@link publishRepoInvalidation} for a write that only knows its chat: the
 * chat's own workdir says which repository it is. A chat that vanished, moved
 * to another user, or has no workdir publishes nothing.
 */
export async function publishRepoInvalidationForChat(
  chat: { readonly userId: string; readonly chatId: string },
  scopes: readonly GitScope[],
  options: RepoInvalidationOptions = {}
): Promise<void> {
  try {
    const record = await getById(chat.chatId, getDb());
    if (record?.userId !== chat.userId || !record.workdir) return;
    await publishRepoInvalidation(
      { userId: chat.userId, environmentId: record.environmentId, workdir: record.workdir },
      scopes,
      options
    );
  } catch (error) {
    logger.error('repo_publish_failed', {
      chatId: chat.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
