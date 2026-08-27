/**
 * The one queue every repository mutation goes through.
 *
 * It lives in its own module rather than beside the write service because
 * three callers now share it — ordinary Git writes, worktree administration
 * and `gh pr checkout` — and a lock two of them take on a different key is not
 * a lock at all.
 */

import { getRuntimeClient } from '../../../services/runtime-client';
import { resolveGitCommonDir } from '../domain/git-common-dir';
import { type GitRuntimeSelection, runGit as runGitDefault } from '../infrastructure/git-cli';

const mutationQueues = new Map<string, Promise<void>>();

/**
 * The two path operations a lock key needs, performed the way the machine that
 * owns the repository would perform them.
 *
 * Structural for the same reason `WorktreePathSemantics` is: these are paths on
 * the runtime, and `TargetPaths` satisfies the shape without this module
 * knowing about the transport.
 */
export interface RepoLockPathSemantics {
  /** Joins a relative path onto an absolute base; an absolute path wins. */
  join(base: string, path: string): string;
  /** The string form two paths naming one directory share. */
  identity(path: string): string;
}

export interface RepoMutationLockOptions {
  /** Injected so a test can resolve a lock key without spawning Git. */
  readonly runGit?: typeof runGitDefault;
  /** Injected so a test can supply path semantics without a runtime connection. */
  readonly readTargetPaths?: (selection: GitRuntimeSelection) => Promise<RepoLockPathSemantics>;
}

/**
 * Serializes mutations that contend on one scope while letting others proceed.
 *
 * `scope` is an opaque key. Callers mutating a repository must not invent one —
 * {@link createRepoMutationLock} derives the only key they may use.
 *
 * @example
 * await withMutationLock('local', '/repo/.git', () => runGit(['commit'], options));
 */
export async function withMutationLock<T>(
  environmentId: string,
  scope: string,
  mutation: () => Promise<T>
): Promise<T> {
  const key = `${environmentId}:${scope}`;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = previous.then(() => current);
  mutationQueues.set(key, queue);

  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (mutationQueues.get(key) === queue) mutationQueues.delete(key);
  }
}

/**
 * Builds the repository-scoped lock over one pair of collaborators.
 *
 * The queue itself stays module-level on purpose: it is the process's single
 * point of serialization, and an instance that owned its own map would hand out
 * a lock nobody else takes.
 *
 * @example
 * const { withRepoMutationLock } = createRepoMutationLock();
 * await withRepoMutationLock(selection, root, () => runGit(['commit'], options));
 */
export function createRepoMutationLock(options: RepoMutationLockOptions = {}) {
  const runGit = options.runGit ?? runGitDefault;
  const readTargetPaths = options.readTargetPaths ?? readRuntimePaths;

  /**
   * The lock key for the repository `root` belongs to.
   *
   * Folded through `identity` rather than used as Git printed it: the queue is
   * a `Map` keyed by string, so on Windows `C:\Repo\.git` and `c:\repo\.git`
   * would take two locks on one directory — the same trap `TargetPaths.equals`
   * closes for worktree comparison, in the one place a comparison cannot be
   * used.
   *
   * @example
   * await resolveRepoLockScope('/repo/wt', selection); // '/repo/.git'
   */
  async function resolveRepoLockScope(
    root: string,
    selection: GitRuntimeSelection,
    signal?: AbortSignal
  ): Promise<string> {
    const paths = await readTargetPaths(selection);
    const result = await runGit(['rev-parse', '--git-common-dir'], {
      cwd: root,
      signal,
      ...selection,
    });
    return paths.identity(resolveGitCommonDir(root, result.stdout, paths));
  }

  /**
   * Runs a mutation under the lock that covers the whole repository.
   *
   * The key is the shared administrative directory, not the caller's root, and
   * that is the whole point: a repository's refs, its worktree registry and its
   * packed objects are one shared state, so a `worktree add` from the main
   * worktree, a `branch -d` from a linked one and a `gh pr checkout` from a
   * third all have to queue behind each other. Keyed on each caller's own root
   * — which is what the write service and the GitHub checkout used to do while
   * worktree administration keyed on the common directory — those three bypass
   * each other and race on the same refs, which is a lock-file failure at best
   * and a command acting on branch state that moved under it at worst.
   *
   * The cost is real and accepted: two chats in two worktrees of one repository
   * now serialize their writes, where index-only mutations (`git add`) could
   * genuinely have run in parallel. Repository mutations here are all
   * human-triggered button presses, so the contention is rare and the
   * correctness is not.
   *
   * @example
   * await withRepoMutationLock(selection, root, () => runGit(['commit'], options));
   */
  async function withRepoMutationLock<T>(
    selection: GitRuntimeSelection,
    root: string,
    mutation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const scope = await resolveRepoLockScope(root, selection, signal);
    return await withMutationLock(selection.environmentId, scope, mutation);
  }

  return { resolveRepoLockScope, withRepoMutationLock };
}

/** How the machine that owns the repository writes and compares its own paths. */
async function readRuntimePaths(selection: GitRuntimeSelection): Promise<RepoLockPathSemantics> {
  const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
  return runtime.paths;
}

export const { withRepoMutationLock } = createRepoMutationLock();
