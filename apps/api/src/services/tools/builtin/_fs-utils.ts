/**
 * Hub-owned filesystem policy helpers. File I/O itself belongs to the runtime.
 */

import { isAbsolute, resolve } from 'node:path';
import {
  PathAccessError,
  type RuntimePathFilter,
  readFileWithObservedMtime,
} from '@mangostudio/runtime';
import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';
import {
  assertInsideWorkdir,
  isPathPrefix,
} from '../../../modules/workspaces/application/path-containment';
import { normalizePathList, normalizeStringList, type PathListItem } from '../list-normalization';
import type { WorkdirPolicy } from '../types';

export { normalizePathList, normalizeStringList, PathAccessError, readFileWithObservedMtime };

export function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    const home = Bun.env.HOME ?? '';
    if (!home) return path;
    return path === '~' ? home : `${home}/${path.slice(2)}`;
  }
  return path;
}

export interface PathValidationSettings {
  allowedPaths: readonly PathListItem[];
  deniedPaths: readonly PathListItem[];
}

export function normalizePathValidationSettings(
  parameters: Record<string, unknown>
): PathValidationSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export function pathPolicyParameterDescriptors(
  allowedDescription: string,
  deniedDescription: string
): ToolParameterDescriptor[] {
  return [
    {
      name: 'allowedPaths',
      label: 'Allowed paths',
      description: allowedDescription,
      type: 'path_list',
      required: false,
      defaultValue: [] as Array<{ path: string; enabled: boolean }>,
    },
    {
      name: 'deniedPaths',
      label: 'Denied paths',
      description: deniedDescription,
      type: 'path_list',
      required: false,
      defaultValue: [] as Array<{ path: string; enabled: boolean }>,
    },
  ];
}

export interface WorkdirResolutionOptions {
  workdir?: string;
  workdirPolicy?: WorkdirPolicy;
}

export interface ResolvePathOptions extends WorkdirResolutionOptions {
  settings: PathValidationSettings;
}

export function getRequiredPathArg(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PathAccessError(`Missing required ${name}.`);
  return text;
}

export function assertWorkdirContainment(
  resolvedPath: string,
  workdirPolicy: WorkdirPolicy | undefined
): void {
  if (!workdirPolicy?.restricted) return;
  try {
    assertInsideWorkdir(workdirPolicy.root, resolvedPath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Path is outside the working directory.';
    throw new PathAccessError(message);
  }
}

export function resolveWorkdirRelativePath(
  inputPath: string,
  options: WorkdirResolutionOptions
): string {
  const expanded = expandHome(inputPath);
  if (isAbsolute(expanded)) return resolve(expanded);

  const workdir = options.workdirPolicy?.root ?? options.workdir;
  if (!workdir) {
    throw new PathAccessError(
      `Relative path "${inputPath}" cannot be resolved: no working directory is bound to this chat. Pass an absolute path.`
    );
  }
  return resolve(workdir, expanded);
}

export function resolveAndValidatePath(inputPath: string, options: ResolvePathOptions): string {
  const resolved = resolveWorkdirRelativePath(inputPath, options);
  const { settings, workdirPolicy } = options;

  const allowedRoots = enabledRoots(settings.allowedPaths);
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => isPathPrefix(root, resolved))) {
    throw new PathAccessError(`Path "${inputPath}" is not in the allowed paths.`);
  }

  const deniedRoots = enabledRoots(settings.deniedPaths);
  if (deniedRoots.some((root) => isPathPrefix(root, resolved))) {
    throw new PathAccessError(`Path "${inputPath}" is in the denied paths.`);
  }

  assertWorkdirContainment(resolved, workdirPolicy);
  return resolved;
}

/**
 * Serializes the already-normalized policy for runtime operations that discover
 * paths internally, such as glob and grep.
 */
export function createRuntimePathFilter(
  settings: PathValidationSettings,
  workdirPolicy: WorkdirPolicy | undefined
): RuntimePathFilter {
  return {
    allowedRoots: enabledRoots(settings.allowedPaths),
    deniedRoots: enabledRoots(settings.deniedPaths),
    ...(workdirPolicy?.restricted ? { containmentRoot: workdirPolicy.root } : {}),
  };
}

function enabledRoots(paths: readonly PathListItem[]): string[] {
  return paths.filter((item) => item.enabled).map((item) => resolve(expandHome(item.path)));
}
