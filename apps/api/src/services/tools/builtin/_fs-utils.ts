/**
 * Shared utilities for filesystem tools: path expansion, allowlist/denylist validation.
 */

import { resolve } from 'node:path';
import { normalizePathList, normalizeStringList, type PathListItem } from '../list-normalization';

export { normalizePathList, normalizeStringList, type PathListItem };

export function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    const home = Bun.env.HOME ?? '';
    if (!home) return path;
    if (path === '~') return home;
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

export interface PathValidationSettings {
  allowedPaths: readonly PathListItem[];
  deniedPaths: readonly PathListItem[];
}

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAccessError';
  }
}

/**
 * Reads a required path argument, throwing PathAccessError when missing.
 * Shared by the filesystem tools so their argument handling stays identical.
 *
 * // Usage: const path = getRequiredPathArg(args.path, 'path');
 */
export function getRequiredPathArg(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PathAccessError(`Missing required ${name}.`);
  return text;
}

export function resolveAndValidatePath(
  inputPath: string,
  settings: PathValidationSettings
): string {
  const expanded = expandHome(inputPath);
  const resolved = resolve(expanded);

  const enabledAllowed = settings.allowedPaths.filter((item) => item.enabled);
  if (enabledAllowed.length > 0) {
    const isAllowed = enabledAllowed.some((allowed) => {
      const allowedResolved = resolve(expandHome(allowed.path));
      return resolved === allowedResolved || resolved.startsWith(`${allowedResolved}/`);
    });
    if (!isAllowed) {
      throw new PathAccessError(`Path "${inputPath}" is not in the allowed paths.`);
    }
  }

  const enabledDenied = settings.deniedPaths.filter((item) => item.enabled);
  if (enabledDenied.length > 0) {
    const isDenied = enabledDenied.some((denied) => {
      const deniedResolved = resolve(expandHome(denied.path));
      return resolved === deniedResolved || resolved.startsWith(`${deniedResolved}/`);
    });
    if (isDenied) {
      throw new PathAccessError(`Path "${inputPath}" is in the denied paths.`);
    }
  }

  return resolved;
}
