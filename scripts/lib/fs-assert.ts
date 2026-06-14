// Filesystem assertions for the release scripts — node:fs only, framework-agnostic.
// Keeps the "Missing <label>: <path>" wording consistent across the asset,
// Docker-staging, and npm-distribution validators.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface SafeDeleteOptions {
  /** Workspace/repo root — this path and its ancestors must not be deleted. */
  readonly rootDir: string;
  /** Additional roots whose descendants may be deleted (typically os.tmpdir()). */
  readonly allowedOutsideRoots?: readonly string[];
  /** Short noun phrase for error messages (e.g. "Docker context"). */
  readonly label?: string;
}

/** Throw when `path` is not an existing file.
 * // Usage: assertFile(binaryPath, 'linux-x64 binary');
 */
export function assertFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

/** Throw when `path` is not an existing directory.
 * // Usage: assertDirectory(publicDir, 'frontend assets directory');
 */
export function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

/** Collect a filesystem error when `path` is missing or is not a file.
 * Returns an empty array when the file is present. Unlike `assertFile`, this is
 * for validators that aggregate every problem before throwing, so it reports a
 * directory-where-a-file-was-expected distinctly instead of as "Missing".
 * // Usage: const errors = fileError(binaryPath, 'binary');
 */
export function fileError(path: string, label: string): string[] {
  if (!existsSync(path)) {
    return [`Missing ${label}: ${path}`];
  }

  if (statSync(path).isFile()) {
    return [];
  }

  return [`Expected ${label} to be a file: ${path}`];
}

/**
 * Fail closed before recursive rmSync: only strict descendants of rootDir or of an
 * allowed outside root (typically the OS temp directory) may be removed.
 * // Usage: assertSafeToDelete(contextDir, { rootDir: ROOT_DIR, allowedOutsideRoots: [tmpdir()] });
 */
export function assertSafeToDelete(path: string, options: SafeDeleteOptions): void {
  const resolved = resolve(path);
  const rootDir = resolve(options.rootDir);
  const allowedRoots = (options.allowedOutsideRoots ?? []).map((root) => resolve(root));
  const label = options.label ?? 'path';

  if (isFilesystemRoot(resolved)) {
    throw refuseDelete(resolved, label);
  }

  if (resolved === rootDir || allowedRoots.some((root) => resolved === root)) {
    throw refuseDelete(resolved, label);
  }

  if (
    isStrictAncestor(resolved, rootDir) ||
    allowedRoots.some((root) => isStrictAncestor(resolved, root))
  ) {
    throw refuseDelete(resolved, label);
  }

  if (
    isStrictDescendant(rootDir, resolved) ||
    allowedRoots.some((root) => isStrictDescendant(root, resolved))
  ) {
    return;
  }

  throw refuseDelete(resolved, label);
}

function refuseDelete(path: string, label: string): never {
  throw new Error(`Refusing to remove ${label} outside the workspace: ${path}`);
}

function isFilesystemRoot(path: string): boolean {
  return resolve(path) === resolve(path, '..');
}

function isStrictAncestor(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isStrictDescendant(parent: string, child: string): boolean {
  return isStrictAncestor(parent, child);
}
