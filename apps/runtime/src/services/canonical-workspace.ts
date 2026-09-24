import { realpath } from 'node:fs/promises';

/**
 * Canonical form of an existing absolute workspace path (symlinks resolved).
 *
 * The single canonicalization shared by `workspace.validate` (whose
 * `resolvedPath` the hub stores as a chat workdir) and the external-agent
 * workspace authorization, so the hub's exact-equality check compares two
 * strings produced by the same function.
 *
 * @example
 * const canonical = await canonicalWorkspacePath('/home/me/app-link');
 */
export function canonicalWorkspacePath(absolutePath: string): Promise<string> {
  return realpath(absolutePath);
}
