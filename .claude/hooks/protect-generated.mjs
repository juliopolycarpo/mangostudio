import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTouchedFilePath } from '../../.codex/hooks/auto-fix.mjs';

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
  const filePath = extractTouchedFilePath(input) || extractNotebookPath(input);
  const match = filePath ? findProtectedFile(resolve(root, filePath), root) : undefined;

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

function toRepoPath(filePath, root) {
  const relativePath = relative(root, filePath).replaceAll('\\', '/');

  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath.replace(nestedWorktreePrefix, '');
}

function extractNotebookPath(input) {
  try {
    return JSON.parse(input)?.tool_input?.notebook_path ?? '';
  } catch {
    return '';
  }
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
