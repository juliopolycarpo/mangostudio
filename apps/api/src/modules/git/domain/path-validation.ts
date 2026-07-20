import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

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
