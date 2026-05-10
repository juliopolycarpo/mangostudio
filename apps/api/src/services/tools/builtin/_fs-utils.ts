/**
 * Shared utilities for filesystem tools: path expansion, allowlist/denylist validation.
 */

import { resolve } from 'node:path';

export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

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
  allowedPaths: readonly string[];
  deniedPaths: readonly string[];
}

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAccessError';
  }
}

export function resolveAndValidatePath(
  inputPath: string,
  settings: PathValidationSettings
): string {
  const expanded = expandHome(inputPath);
  const resolved = resolve(expanded);

  if (settings.allowedPaths.length > 0) {
    const isAllowed = settings.allowedPaths.some((allowed) => {
      const allowedResolved = resolve(expandHome(allowed));
      return resolved === allowedResolved || resolved.startsWith(`${allowedResolved}/`);
    });
    if (!isAllowed) {
      throw new PathAccessError(`Path "${inputPath}" is not in the allowed paths.`);
    }
  }

  if (settings.deniedPaths.length > 0) {
    const isDenied = settings.deniedPaths.some((denied) => {
      const deniedResolved = resolve(expandHome(denied));
      return resolved === deniedResolved || resolved.startsWith(`${deniedResolved}/`);
    });
    if (isDenied) {
      throw new PathAccessError(`Path "${inputPath}" is in the denied paths.`);
    }
  }

  return resolved;
}
