/**
 * Tells the panel its GitHub data is stale, the moment a write lands.
 *
 * Reuses the git chat topic and the `github` scope that already exist in
 * `@mangostudio/shared/realtime` rather than inventing a mechanism: the GitHub
 * panel lives beside the git panel, subscribed to the same `git:<chatId>` topic,
 * and `GitScopeSchema` already carries `github` for exactly this.
 *
 * It does not go through `publishGitWriteInvalidation`, because that function's
 * scope map is keyed by *git* write operations and `pr checkout` is not one of
 * them. Publishing here keeps the mapping from a GitHub action to the slices it
 * invalidates next to the actions themselves.
 *
 * The publish fans out to every chat the same user has bound to the same
 * workdir on the same machine, not just the chat that made the write: a second
 * panel open on the repository reads the same GitHub state and the same working
 * tree, so it is exactly as stale as the first (#943). For `checkout`, which
 * already resolves the worktree root to serialize against the git write queue,
 * that fan-out widens to every chat bound anywhere under the root — a chat
 * bound to a package subdirectory of the same checkout shares the same HEAD,
 * index and working tree just as much as one bound to the root (#944). The
 * initiating chat is published synchronously and unconditionally; the sibling
 * enumeration is one database read that runs after it and is failure-isolated,
 * because the write already happened and a lookup error must not turn it into
 * an apparent failure. Siblings in *other* checkouts of the same repository are
 * still out of this set on purpose — their staleness line ages visibly until
 * the repo-scoped topic follow-up lands.
 */

import { type GitScope, gitTopic } from '@mangostudio/shared/realtime';
import { getDb } from '../../../db/database';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRealtimeBus } from '../../../services/realtime/realtime-bus';
import {
  listChatIdsByWorkdir,
  listChatIdsUnderWorktreeRoot,
} from '../../chats/infrastructure/chat-repository';

const logger = createDiagnosticLogger('github-realtime');

/**
 * What each write can change.
 *
 * `checkout` is the broad one and has to be: it fetches a ref and switches
 * branches, so the working tree, the branch list, the history and every diff on
 * screen are all about a different commit afterwards. Creating a pull request
 * or marking one ready touches GitHub and nothing on disk. Siblings share the
 * workdir, so the broad scopes apply to them just as much as to the initiator.
 */
const GITHUB_WRITE_SCOPES = {
  create: ['github'],
  ready: ['github'],
  checkout: ['state', 'branches', 'history', 'diffs', 'github'],
} as const satisfies Record<string, readonly GitScope[]>;

export type GithubWriteOperation = keyof typeof GITHUB_WRITE_SCOPES;

export interface GithubInvalidationTarget {
  readonly userId: string;
  readonly chatId: string;
  readonly environmentId: string;
  readonly workdir: string;
  /** The resolved worktree root, when the write already resolved one (checkout). */
  readonly root?: string;
}

export type ListSiblingChatIds = (
  userId: string,
  environmentId: string,
  workdir: string,
  root?: string
) => Promise<string[]>;

export interface GithubRealtimeOptions {
  /** Injected so a test can enumerate siblings without a database. */
  readonly listSiblingChatIds?: ListSiblingChatIds;
}

const defaultListSiblingChatIds: ListSiblingChatIds = (userId, environmentId, workdir, root) =>
  root
    ? listChatIdsUnderWorktreeRoot(userId, environmentId, root, getDb())
    : listChatIdsByWorkdir(userId, environmentId, workdir, getDb());

/**
 * Publishes only after the write has succeeded. Resolves once the fan-out has
 * been attempted; never rejects.
 *
 * @example
 * void publishGithubWriteInvalidation({ userId, chatId, environmentId, workdir }, 'checkout');
 */
export async function publishGithubWriteInvalidation(
  target: GithubInvalidationTarget,
  operation: GithubWriteOperation,
  options: GithubRealtimeOptions = {}
): Promise<void> {
  const bus = getRealtimeBus();
  const scopes = GITHUB_WRITE_SCOPES[operation];
  bus.publish(target.userId, {
    type: 'invalidate',
    topic: gitTopic(target.chatId),
    scopes: [...scopes],
  });

  const listSiblingChatIds = options.listSiblingChatIds ?? defaultListSiblingChatIds;
  try {
    const chatIds = await listSiblingChatIds(
      target.userId,
      target.environmentId,
      target.workdir,
      target.root
    );
    for (const chatId of new Set(chatIds)) {
      if (chatId === target.chatId) continue;
      bus.publish(target.userId, {
        type: 'invalidate',
        topic: gitTopic(chatId),
        scopes: [...scopes],
      });
    }
  } catch (error) {
    logger.error('sibling_fanout_failed', {
      chatId: target.chatId,
      environmentId: target.environmentId,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
