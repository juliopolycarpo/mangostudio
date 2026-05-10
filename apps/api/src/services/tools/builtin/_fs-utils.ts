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

export function normalizePathList(value: unknown): PathListItem[] {
  if (Array.isArray(value)) {
    // If the array contains only strings, treat it as a legacy string list
    const allStrings = value.every((item) => typeof item === 'string');
    if (allStrings) {
      const strings = normalizeStringList(value);
      return strings.map((path) => ({ path, enabled: true }));
    }

    const items: PathListItem[] = [];
    for (const raw of value) {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'path' in raw &&
        typeof (raw as Record<string, unknown>).path === 'string' &&
        'enabled' in raw &&
        typeof (raw as Record<string, unknown>).enabled === 'boolean'
      ) {
        const entry = raw as { path: string; enabled: boolean };
        const trimmed = entry.path.trim();
        if (trimmed.length > 0) {
          items.push({ path: trimmed, enabled: entry.enabled });
        }
      }
    }
    return items;
  }
  // Backward compatibility: newline-separated string
  const strings = normalizeStringList(value);
  return strings.map((path) => ({ path, enabled: true }));
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

export interface PathListItem {
  path: string;
  enabled: boolean;
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
