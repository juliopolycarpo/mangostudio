// Literal repository paths shared by the CI relevance adapters. Git's default
// name list quotes Unicode and control characters; only `--name-only -z` is a
// filename transport. Reject malformed input before any adapter emits a skip.
import { readFileSync } from 'node:fs';

/**
 * Validate without trimming, unquoting or otherwise guessing filenames.
 * @example
 * validateChangedPaths(['crates/runtime/src/café.rs']);
 */
export function validateChangedPaths(paths: readonly string[]): void {
  if (paths.length === 0) throw new Error('changed-paths: empty diff; refusing to skip lanes');
  for (const path of paths) {
    if (
      path === '' ||
      path.includes('\0') ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(`changed-paths: invalid repository-relative path: ${JSON.stringify(path)}`);
    }
  }
}

/**
 * Decode the complete, NUL-terminated output of `git diff --name-only -z`.
 * @example
 * decodeChangedPaths(new TextEncoder().encode('Cargo.toml\0')); // ['Cargo.toml']
 */
export function decodeChangedPaths(bytes: Uint8Array): string[] {
  if (bytes.length === 0) throw new Error('changed-paths: empty diff; refusing to skip lanes');
  if (bytes[bytes.length - 1] !== 0) {
    throw new Error('changed-paths: expected NUL-terminated git paths');
  }
  const paths = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(bytes)
    .slice(0, -1)
    .split('\0');
  validateChangedPaths(paths);
  return paths;
}

/**
 * Read a checked NUL path file; missing files and invalid UTF-8 fail closed.
 * @example
 * const paths = readChangedPaths('changed.nul');
 */
export function readChangedPaths(file: string | undefined): string[] {
  if (!file) throw new Error('changed-paths: expected a NUL path file');
  return decodeChangedPaths(readFileSync(file));
}
