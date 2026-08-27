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
 */

import { type GitScope, gitTopic } from '@mangostudio/shared/realtime';
import { getRealtimeBus } from '../../../services/realtime/realtime-bus';

/**
 * What each write can change.
 *
 * `checkout` is the broad one and has to be: it fetches a ref and switches
 * branches, so the working tree, the branch list, the history and every diff on
 * screen are all about a different commit afterwards. Creating a pull request
 * or marking one ready touches GitHub and nothing on disk.
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
}

/**
 * Publishes only after the write has succeeded.
 *
 * @example
 * publishGithubWriteInvalidation({ userId, chatId }, 'checkout');
 */
export function publishGithubWriteInvalidation(
  target: GithubInvalidationTarget,
  operation: GithubWriteOperation
): void {
  getRealtimeBus().publish(target.userId, {
    type: 'invalidate',
    topic: gitTopic(target.chatId),
    scopes: [...GITHUB_WRITE_SCOPES[operation]],
  });
}
