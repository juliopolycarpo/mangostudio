import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import { getRuntimeClient } from '../../../services/runtime-client';
import type { GitRuntimeSelection } from '../infrastructure/git-cli';

export class GitPathValidationError extends Error {
  constructor(path: string) {
    super(`Invalid repository path: ${path}`);
    this.name = 'GitPathValidationError';
  }
}

/**
 * Re-validates untrusted paths and returns them as Git pathspecs.
 *
 * Containment is only half the job: `--` separates revisions from paths but
 * does NOT disable pathspec magic, so `:/` or `:(exclude)x` would pass a purely
 * lexical check — they resolve inside the root — and still widen the operation
 * to files the caller never selected. The `:(literal)` prefix pins each entry
 * to the exact path. It is applied per pathspec rather than through
 * `GIT_LITERAL_PATHSPECS`, because that variable also strips the magic Git
 * generates internally and would silently break commands like `stash push -u`.
 */
export function validateRepoPaths(root: string, paths: readonly string[]): string[] {
  const resolvedRoot = resolve(root);

  return paths.map((path) => {
    if (path.length === 0 || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path)) {
      throw new GitPathValidationError(path);
    }

    // Treat both separators as path boundaries so requests are equally safe on
    // Unix and Windows, even when a foreign-style path reaches the API.
    const portablePath = path.replaceAll('\\', '/');
    const resolvedPath = resolve(resolvedRoot, portablePath);
    const relativePath = relative(resolvedRoot, resolvedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new GitPathValidationError(path);
    }

    return `:(literal)${path}`;
  });
}

/**
 * Resolves a repository-relative path to its real location and re-checks
 * containment after following symlinks.
 *
 * `validateRepoPaths` is purely lexical, which is enough for pathspecs because
 * Git refuses to traverse a symlinked directory while walking the worktree.
 * Commands that read the filesystem directly — notably `git diff --no-index` —
 * do follow them, so a `link -> /etc` directory symlink inside the repository
 * would otherwise expose files outside the root. Returns the contained
 * repository-relative path, or null when the path does not exist.
 *
 * The lexical pre-check stays hub-side because it is a rejection policy, but the
 * symlink resolution runs in the runtime: `realpath` is a fact about the machine
 * that owns the repository, and resolving it here would consult the hub's
 * filesystem once the runtime is remote.
 */
export async function resolveContainedPath(
  root: string,
  path: string,
  selection?: GitRuntimeSelection
): Promise<string | null> {
  validateRepoPaths(root, [path]);

  const runtime = await getRuntimeClient(selection?.userId, selection?.environmentId);
  try {
    const { relativePath } = await runtime.workspace.resolveContained({ root, path });
    return relativePath;
  } catch (error) {
    if (error instanceof RuntimeRemoteError && error.details?.kind === 'workspace_containment') {
      throw new GitPathValidationError(path);
    }
    throw error;
  }
}
