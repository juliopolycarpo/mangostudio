import { readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const nestedWorktreePrefix = /^\.claude\/worktrees\/[^/]+\//;
const protectedFiles = [
  { path: 'CHANGELOG.md', regenerate: 'bun run changelog' },
  {
    path: 'packages/protocol/CHANGELOG.md',
    regenerate: 'bun run protocol:release:prepare <version>',
  },
  {
    path: 'apps/frontend/src/routeTree.gen.ts',
    regenerate: 'bun run --filter @mangostudio/frontend routes',
  },
  { path: 'bun.lock', regenerate: 'bun install (or bun add / bun remove)' },
  { path: 'Cargo.lock', regenerate: 'cargo update (or cargo add / cargo build)' },
  {
    path: 'crates/mango-protocol/fuzz/Cargo.lock',
    regenerate: 'cargo update -w --manifest-path crates/mango-protocol/fuzz/Cargo.toml',
  },
];
const protectedDirectories = [
  { path: 'apps/shared/src/runtime-contract/generated/', regenerate: 'bun run contracts:emit' },
];

/**
 * Read the touched file path from a Claude hook payload.
 * // Usage: const filePath = extractTouchedFilePath(input);
 */
export function extractTouchedFilePath(input) {
  const parsed = parseHookInput(input);
  return (
    parsed?.tool_input?.file_path ??
    parsed?.tool_input?.notebook_path ??
    parsed?.tool_input?.path ??
    parsed?.file_path ??
    parsed?.path ??
    ''
  );
}

/**
 * Read the hook's absolute working directory, falling back to the repository root.
 * // Usage: const cwd = extractHookCwd(input); // '/repo/packages/protocol'
 */
export function extractHookCwd(input, root = repoRoot) {
  const cwd = parseHookInput(input)?.cwd;
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : root;
}

/**
 * List the absolute paths a touched file may name: from the hook cwd first, then the repo root
 * when the cwd is inside the repo, since agents also send repo-relative paths from nested dirs.
 * // Usage: candidatePaths('CHANGELOG.md', '/repo/packages/protocol', '/repo'); // ['/repo/packages/protocol/CHANGELOG.md', '/repo/CHANGELOG.md']
 */
export function candidatePaths(filePath, cwd, root = repoRoot) {
  if (!filePath) {
    return [];
  }

  const fromCwd = absolutePathForLookup(filePath, cwd);
  if (isAbsolute(filePath)) {
    return [fromCwd];
  }

  return isInsideRepo(cwd, root) ? [fromCwd, absolutePathForLookup(filePath, root)] : [fromCwd];
}

/**
 * Anchor a path for filesystem lookup, preserving parent segments on POSIX.
 * // Usage: absolutePathForLookup('src/file.ts', resolve('repo'));
 */
export function absolutePathForLookup(filePath, cwd) {
  if (isAbsolute(filePath)) return sep === '/' ? filePath : resolve(filePath);
  if (sep !== '/') return resolve(cwd, filePath);

  // The filesystem must follow a symlink before processing a subsequent '..'.
  return cwd.endsWith(sep) ? cwd + filePath : cwd + sep + filePath;
}

/**
 * Check whether a resolved file path belongs to the current repository.
 * // Usage: if (!isInsideRepo(filePath)) return;
 */
export function isInsideRepo(filePath, root = repoRoot) {
  const relativePath = relative(root, filePath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function toSlashPath(filePath) {
  return filePath.replaceAll(sep, '/');
}

function parseHookInput(input) {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/**
 * Match a touched file against the generated files agents must not edit by hand.
 * // Usage: const match = findProtectedFile('/repo/bun.lock', '/repo'); // { path: 'bun.lock', regenerate: 'bun install …' }
 */
export function findProtectedFile(filePath, root = repoRoot) {
  const relativePath = toRepoPath(filePath, root);

  if (!relativePath) {
    return undefined;
  }

  const file = protectedFiles.find((entry) => entry.path === relativePath);

  if (file) {
    return file;
  }

  const directory = protectedDirectories.find((entry) => relativePath.startsWith(entry.path));
  return directory ? { path: relativePath, regenerate: directory.regenerate } : undefined;
}

/**
 * Decide whether a Claude PreToolUse payload edits a generated file.
 * // Usage: const { blocked, message } = runProtectGeneratedHook(stdinText);
 */
export function runProtectGeneratedHook(input, root = repoRoot) {
  const filePath = extractTouchedFilePath(input);
  const candidates = candidatePaths(filePath, extractHookCwd(input, root), root);
  const match =
    candidates.map((candidate) => findProtectedFile(candidate, root)).find(Boolean) ??
    findProtectedTarget(candidates, root);

  if (!match) {
    return { blocked: false, message: '' };
  }

  return {
    blocked: true,
    message:
      `Blocked edit to generated file: ${match.path}. ` +
      `Expected: regenerate it with \`${match.regenerate}\` instead of editing it by hand.`,
  };
}

function findProtectedTarget(candidates, root) {
  if (candidates.length === 0) return undefined;
  const resolvedRoot = resolveEditTarget(root);
  if (!resolvedRoot) return undefined;

  for (const candidate of candidates) {
    const target = resolveEditTarget(candidate);
    const match = target && findProtectedFile(target, resolvedRoot);
    if (match) return match;
  }
  return undefined;
}

// An edit may create a file, including through a dangling symlink or a linked parent.
function resolveEditTarget(filePath, links = 0) {
  try {
    return realpathSync.native(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return undefined;
  }

  const parent = dirname(filePath);
  if (parent === filePath) return undefined;

  let link;
  try {
    link = readlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') return undefined;
  }

  if (link !== undefined) {
    return links < 40
      ? resolveEditTarget(absolutePathForLookup(link, parent), links + 1)
      : undefined;
  }

  const resolvedParent = resolveEditTarget(parent, links);
  return resolvedParent && join(resolvedParent, basename(filePath));
}

/**
 * Return a contained path with portable separators for generated-file matching.
 * // Usage: toRepoPath('/repo/..notes/sample.rs', '/repo'); // '..notes/sample.rs'
 */
export function toRepoPath(filePath, root) {
  if (!isInsideRepo(filePath, root)) {
    return undefined;
  }

  const relativePath = toSlashPath(relative(root, filePath));
  return relativePath.replace(nestedWorktreePrefix, '');
}

async function readStdin() {
  return await new Response(Bun.stdin.stream()).text();
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { blocked, message } = runProtectGeneratedHook(await readStdin());

  if (blocked) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}
