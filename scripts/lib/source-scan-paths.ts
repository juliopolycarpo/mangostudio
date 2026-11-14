// Which files each of `bun run check`'s source scans enumerates from disk.
//
// A scan and its pass stamp (`source-scan-stamp.ts`) must agree on this list, or
// the stamp can replay a pass over a file the scan would have read. Each
// enumeration therefore lives here, once, and both sides call it. The module
// stays free of the TypeScript compiler (about 250 ms to load) so `check.ts`
// can import it without paying for the scanners.

import { type Dirent, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Directory names the cycle scan skips at any depth. */
const OMIT_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo']);

/**
 * Whether the cycle scan skips a path: a build or dependency directory at any
 * depth, the root `.mango` and `target`, the fuzz crate's `target`, and the
 * `.claude/worktrees` directory, whose entries are other checkouts of this
 * repository rather than part of this one.
 *
 * @example
 * isCycleScanExcluded('/repo/.claude/worktrees/a/src/x.ts', '/repo'); // true
 */
export function isCycleScanExcluded(path: string, root: string): boolean {
  const segments = relative(root, path).split(sep);
  return (
    segments.some((segment) => OMIT_DIRECTORIES.has(segment)) ||
    segments[0] === '.mango' ||
    segments[0] === 'target' ||
    (segments[0] === '.claude' && segments[1] === 'worktrees') ||
    (segments[0] === 'crates' &&
      segments[1] === 'mango-protocol' &&
      segments[2] === 'fuzz' &&
      segments[3] === 'target')
  );
}

/**
 * Walk the repository outside what `isCycleScanExcluded` skips and call `visit`
 * with every non-directory entry. Symlinked directories are not followed: an
 * import resolves to a real path, which the walk reaches on its own.
 */
function walkCycleScanTree(
  rootDir: string,
  visit: (entry: Dirent, absolute: string, relativePosix: string) => void
): void {
  const base = realpathSync.native(rootDir);
  const walk = (directory: string): void => {
    if (isCycleScanExcluded(directory, base)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (caught) {
      // A build step removes or renames a staging directory (`dist.aside-*`) mid-walk.
      const code = (caught as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw caught;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else visit(entry, child, relative(base, child).split(sep).join('/'));
    }
  };
  walk(base);
}

/**
 * Every file under the repository whose name matches `pattern`, outside what
 * `isCycleScanExcluded` skips, as repository-relative POSIX paths.
 *
 * This is a superset of what the cycle scan can read. The scan walks its roots
 * and then follows imports to any file that is inside the repository and not
 * excluded; a resolved path has no symlink component, so a walk from the root
 * over real directories reaches it. Gitignored files count, which is why this
 * reads the disk and not the Git index. Symlinks are not files here: see
 * `listCycleScanTreeSymlinks` for the links the same walk meets.
 *
 * @example
 * listCycleScanTreeFiles('/repo', /\.tsx?$/); // ['apps/api/src/app.ts', ...]
 */
export function listCycleScanTreeFiles(rootDir: string, pattern: RegExp): string[] {
  const found: string[] = [];
  walkCycleScanTree(rootDir, (entry, _absolute, path) => {
    if (entry.isFile() && pattern.test(entry.name)) found.push(path);
  });
  return found.sort();
}

/**
 * Every symlink the cycle scan's walk meets, as `path -> target` lines with the
 * link's own repository-relative POSIX path and the text `readlink` returns.
 *
 * A link redirects an import to a file the key already hashes under its real
 * path, so retargeting one changes the scan's verdict while no hashed byte
 * moves. The target text is therefore part of the key.
 *
 * @example
 * listCycleScanTreeSymlinks('/repo'); // ['apps/api/src/vendor -> ../../shared/src']
 */
export function listCycleScanTreeSymlinks(rootDir: string): string[] {
  const found: string[] = [];
  walkCycleScanTree(rootDir, (entry, absolute, path) => {
    if (!entry.isSymbolicLink()) return;
    const line = describeSymlink(path, absolute);
    if (line !== null) found.push(line);
  });
  return found.sort();
}

/**
 * `listCycleScanTreeFiles` and `listCycleScanTreeSymlinks` from one walk, for a
 * caller that needs both and would otherwise read every directory twice.
 *
 * @example
 * listCycleScanTree('/repo', /\.tsx?$/); // { files: ['apps/api/src/app.ts'], symlinks: [] }
 */
export function listCycleScanTree(
  rootDir: string,
  pattern: RegExp
): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  walkCycleScanTree(rootDir, (entry, absolute, path) => {
    if (entry.isFile() && pattern.test(entry.name)) files.push(path);
    else if (entry.isSymbolicLink()) {
      const line = describeSymlink(path, absolute);
      if (line !== null) symlinks.push(line);
    }
  });
  return { files: files.sort(), symlinks: symlinks.sort() };
}

/**
 * `text` with the platform separator spelled `/`, so a path from the OS reads like
 * the POSIX paths Git lists. Where the separator is already `/` the text is
 * returned as is: a backslash is then an ordinary filename character.
 *
 * @example
 * posixText('..\\..\\shared\\src', '\\'); // '../../shared/src'
 */
export function posixText(text: string, separator: string = sep): string {
  return separator === '/' ? text : text.replaceAll(separator, '/');
}

/**
 * What `readlink` says a symlink points at, in POSIX spelling, or null when
 * `absolute` is not a symlink (or is gone). It is the link's own text, not a
 * resolved path: a retarget to a path that does not exist yet still changes it.
 * On Windows a junction reads back as an absolute path and a symlink as the
 * relative text it was made with; both are kept as read. The key only has to be
 * stable on one machine.
 */
export function readSymlinkTarget(absolute: string): string | null {
  try {
    return posixText(readlinkSync(absolute));
  } catch (caught) {
    // EINVAL: not a symlink. ENOENT: removed since the listing.
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOENT') return null;
    throw caught;
  }
}

/** `path -> target` for a symlink, or null when `absolute` is not one. */
function describeSymlink(path: string, absolute: string): string | null {
  const target = readSymlinkTarget(absolute);
  return target === null ? null : `${path} -> ${target}`;
}

/**
 * The symlinks among `paths` (repository-relative, as Git lists them), as
 * `path -> target` lines. Git lists a symlink as a file whatever its name, so
 * this catches links the walk skips: one under a directory the cycle scan
 * excludes, which `shared-import-boundary` still reads when Git lists it.
 *
 * @example
 * listSymlinksAmong('/repo', ['apps/api/src/vendor', 'README.md']); // ['apps/api/src/vendor -> ../../shared/src']
 */
export function listSymlinksAmong(rootDir: string, paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of paths) {
    let isLink: boolean;
    try {
      isLink = lstatSync(join(rootDir, path)).isSymbolicLink();
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw caught;
    }
    if (!isLink) continue;
    const line = describeSymlink(path, join(rootDir, path));
    if (line !== null) found.push(line);
  }
  return found.sort();
}

/**
 * The production sources the `NODE_ENV` scan reads: every JS or TS file under
 * `apps/*\/src`, dot directories left out by the glob, nothing else excluded.
 *
 * @example
 * listNodeEnvScanPaths('/repo'); // ['apps/api/src/app.ts', ...]
 */
export function listNodeEnvScanPaths(rootDir: string): string[] {
  const glob = new Bun.Glob('apps/*/src/**/*.{js,jsx,ts,tsx,mjs,cjs}');
  // Normalised before sorting: `\` sorts after `/` and Git lists POSIX paths.
  return [...glob.scanSync({ cwd: rootDir, onlyFiles: true })]
    .map((path) => posixText(path))
    .sort();
}

/** Top-level frontend directories the API import scan skips: generated or tool output. */
const FRONTEND_IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  '.mango',
]);

/**
 * The files the frontend API import scan reads: every JS or TS file under
 * `apps/frontend`, dot directories and gitignored files included, minus the
 * generated directories at the workspace root only.
 *
 * @example
 * listFrontendBoundaryPaths('/repo'); // ['apps/frontend/build.ts', ...]
 */
export function listFrontendBoundaryPaths(rootDir: string): string[] {
  const glob = new Bun.Glob('apps/frontend/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
  return [...glob.scanSync({ cwd: rootDir, onlyFiles: true, dot: true })]
    .map((path) => posixText(path))
    .filter((path) => !FRONTEND_IGNORED_DIRECTORIES.has(path.split('/')[2] ?? ''))
    .sort();
}
