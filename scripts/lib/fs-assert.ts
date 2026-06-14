// Filesystem assertions for the release scripts — node:fs only, framework-agnostic.
// Keeps the "Missing <label>: <path>" wording consistent across the asset,
// Docker-staging, and npm-distribution validators.

import { existsSync, statSync } from 'node:fs';

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
