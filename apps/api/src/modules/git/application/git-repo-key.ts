/**
 * The stable identity a repository goes by on the realtime channel.
 *
 * Two chats are "in the same repository" when Git says their checkouts share a
 * common directory, not when their stored workdir strings agree: a chat bound to
 * `/repo/packages/api`, one bound to `/repo`, one reaching it through a symlink
 * and one in a linked worktree all share one set of refs, one remote and one
 * pull request list. The key is derived from the same lock scope that serializes
 * repository mutations ({@link resolveRepoLockScope}), so "what contends on a
 * write" and "what hears about it" cannot drift apart: Git resolves the root and
 * the common directory (symlinks included) and the runtime's own path semantics
 * fold case where its filesystem does.
 *
 * The key is a digest, not the path: it travels in a topic string, which must
 * stay short and must not carry a filesystem layout to the browser.
 */

import { createHash } from 'node:crypto';

import { REPO_KEY_MAX_LENGTH } from '@mangostudio/shared/realtime';

import { createDiagnosticLogger } from '../../../lib/logger';
import type { GitRuntimeSelection } from '../infrastructure/git-cli';
import { resolveRepoLockScope as resolveRepoLockScopeDefault } from './git-mutation-lock';

const logger = createDiagnosticLogger('git-repo-key');

/** How long a root keeps its key. A repository's common directory does not move. */
const REPO_KEY_TTL_MS = 60_000;
/** Roots remembered at once; the oldest is dropped first. */
const REPO_KEY_CACHE_LIMIT = 512;

export type ResolveRepoLockScope = (
  root: string,
  selection: GitRuntimeSelection,
  signal?: AbortSignal
) => Promise<string>;

export interface RepoKeyResolverOptions {
  /** Injected so a test can resolve a key without spawning Git. */
  readonly resolveLockScope?: ResolveRepoLockScope;
  readonly now?: () => number;
}

export type ResolveRepoKey = (
  selection: GitRuntimeSelection,
  root: string
) => Promise<string | undefined>;

/**
 * Digest of one environment's repository scope.
 *
 * The environment id is part of the input: the same path on two machines is two
 * repositories.
 *
 * @example
 * deriveRepoKey('local', '/repo/.git'); // 43 URL-safe characters
 */
export function deriveRepoKey(environmentId: string, lockScope: string): string {
  const key = createHash('sha256').update(`${environmentId}\0${lockScope}`).digest('base64url');
  // sha256 in base64url is 43 characters; the guard keeps the topic bound honest
  // if the digest is ever swapped for a longer one.
  if (key.length > REPO_KEY_MAX_LENGTH) {
    throw new RangeError(`repo key exceeds ${REPO_KEY_MAX_LENGTH} characters`);
  }
  return key;
}

/**
 * Builds a resolver that answers "which repository is this worktree root in".
 *
 * Never rejects: a repository whose common directory cannot be read simply has
 * no key, and every caller degrades to the per-chat topic. Results are cached
 * briefly per `(environment, root)` and concurrent lookups share one Git call,
 * because tool writes and turn completions publish often and each publish
 * would otherwise spawn a process.
 *
 * @example
 * const key = await resolveRepoKey({ userId, environmentId: 'local' }, '/repo');
 */
export function createRepoKeyResolver(options: RepoKeyResolverOptions = {}): ResolveRepoKey {
  const resolveLockScope = options.resolveLockScope ?? resolveRepoLockScopeDefault;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly key: string; readonly expiresAt: number }>();
  const inFlight = new Map<string, Promise<string | undefined>>();

  async function lookup(
    cacheKey: string,
    selection: GitRuntimeSelection,
    root: string
  ): Promise<string | undefined> {
    try {
      const scope = await resolveLockScope(root, selection);
      const key = deriveRepoKey(selection.environmentId, scope);
      cache.delete(cacheKey);
      cache.set(cacheKey, { key, expiresAt: now() + REPO_KEY_TTL_MS });
      if (cache.size > REPO_KEY_CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return key;
    } catch (error) {
      logger.warn('repo_key_unavailable', {
        environmentId: selection.environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  return (selection, root) => {
    const cacheKey = `${selection.userId}\0${selection.environmentId}\0${root}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.key);
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;
    // `finally` runs on a later turn even when `lookup` settles at once, so the
    // entry is always registered before it is removed.
    const started = lookup(cacheKey, selection, root).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, started);
    return started;
  };
}

/** The process-wide resolver the read and write paths share. */
export const resolveRepoKey: ResolveRepoKey = createRepoKeyResolver();
