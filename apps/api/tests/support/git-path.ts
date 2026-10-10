import { sep } from 'node:path';

/**
 * A path as Git spells it on a host whose separator is `separator`. Git for
 * Windows answers `C:/repo/feature` for a directory the host names
 * `C:\repo\feature`; on a POSIX host the two spellings are the same string.
 *
 * @example
 * gitSpelling('C:\\repo\\feature', '\\'); // 'C:/repo/feature'
 * gitSpelling('/repo/feature', '/'); // '/repo/feature'
 */
export function gitSpelling(path: string, separator: string): string {
  return separator === '\\' ? path.replaceAll('\\', '/') : path;
}

/**
 * A path in the spelling Git reports it in on the host running the test.
 *
 * A fixture builds its directories with `join`, so it holds the host spelling,
 * while a route that relays `rev-parse --show-toplevel` or
 * `worktree list --porcelain` reports Git's. Run an expected path through this
 * before comparing it with one of those answers. It takes one argument so it
 * can be handed to `map` directly.
 *
 * @example
 * expect(payload.root).toBe(asGitPath(workdir));
 * expect(listed.map((worktree) => worktree.path)).toEqual([root, linked].map(asGitPath));
 */
export function asGitPath(path: string): string {
  return gitSpelling(path, sep);
}
