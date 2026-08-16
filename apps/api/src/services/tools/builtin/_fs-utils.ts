/**
 * Hub-owned filesystem policy helpers. File I/O itself belongs to the runtime,
 * and so does enforcement: everything decided here is decided lexically, in the
 * target's path style, and re-checked against the real filesystem by the host
 * that owns it (see `pathPolicy` on the runtime filesystem methods).
 */

import {
  PathAccessError,
  type RuntimePathFilter,
  type RuntimePathPolicyParams,
  readFileWithObservedMtime,
} from '@mangostudio/runtime';
import type { ToolParameterDescriptor } from '@mangostudio/shared/tool-settings';
import type { TargetPaths } from '../../runtime-client';
import { normalizePathList, normalizeStringList, type PathListItem } from '../list-normalization';
import type { WorkdirPolicy } from '../types';

export { normalizePathList, normalizeStringList, PathAccessError, readFileWithObservedMtime };

/**
 * Expands a leading `~` against the *target's* home directory. The hub's own
 * `HOME` describes the wrong machine, and on Windows hubs it is usually not
 * even set, which used to leave the tilde in place as a literal directory name.
 */
export function expandHome(path: string, paths: TargetPaths): string {
  const bare = path === '~';
  const prefixed = path.startsWith('~/') || (paths.sep === '\\' && path.startsWith('~\\'));
  if ((!bare && !prefixed) || !paths.homeDir) return path;
  return bare ? paths.canonical(paths.homeDir) : paths.join(paths.homeDir, path.slice(2));
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
  /** Path semantics of the environment this call is bound for. */
  paths: TargetPaths;
}

export interface ResolvePathOptions extends WorkdirResolutionOptions {
  settings: PathValidationSettings;
}

export function getRequiredPathArg(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PathAccessError(`Missing required ${name}.`);
  return text;
}

/**
 * Lexical containment against the chat's working directory. A path that reaches
 * outside through a symbolic link still looks contained from here — the link is
 * on the target's disk, not the hub's — so this is the policy half only, and
 * the runtime re-checks the same root after following what it finds.
 */
export function assertWorkdirContainment(
  resolvedPath: string,
  options: WorkdirResolutionOptions
): void {
  const { workdirPolicy, paths } = options;
  if (!workdirPolicy?.restricted) return;

  const root = paths.canonical(expandHome(workdirPolicy.root, paths));
  if (!paths.contains(root, resolvedPath)) {
    throw new PathAccessError(
      `Path "${resolvedPath}" is outside the chat working directory. Use a path inside "${workdirPolicy.root}".`
    );
  }
}

export function resolveWorkdirRelativePath(
  inputPath: string,
  options: WorkdirResolutionOptions
): string {
  const { paths } = options;
  const expanded = expandHome(inputPath, paths);
  if (paths.isAbsolute(expanded)) return paths.canonical(expanded);

  const workdir = options.workdirPolicy?.root ?? options.workdir;
  if (!workdir) {
    throw new PathAccessError(
      `Relative path "${inputPath}" cannot be resolved: no working directory is bound to this chat. Pass an absolute path.`
    );
  }

  // The chat's workdir is validated by the runtime that owns it before it is
  // stored, and rebinding a chat to another environment clears it — so this
  // holds. It is asserted anyway because the alternative is silent: `resolve`
  // answers a relative base with the *hub's* working directory, which on a
  // Windows hub driving a Linux target is a path on the wrong machine
  // altogether. Failing here is the difference between a refused call and a
  // write that lands somewhere nobody named.
  const base = expandHome(workdir, paths);
  if (!paths.isAbsolute(base)) {
    throw new PathAccessError(
      `Relative path "${inputPath}" cannot be resolved: the working directory "${workdir}" is not an absolute path on this environment. Pass an absolute path.`
    );
  }
  return paths.join(base, expanded);
}

/**
 * Renders an absolute result path the way the tools accept one: relative to the
 * chat working directory.
 *
 * The inverse of {@link resolveWorkdirRelativePath}, and deliberately its
 * neighbour — together they are the round trip the tools promise, that a path
 * one tool reports can be passed into another and reach the same file. Reporting
 * a path relative to a *search root* breaks that promise the moment the search
 * root is not the working directory: `grep(path: 'src')` used to answer `a.ts`
 * for a file only reachable as `src/a.ts`.
 *
 * Two cases fall back to the absolute path, because a relative one would be
 * worse than verbose: a chat with no working directory bound has nothing to
 * anchor against, and a match outside the working directory would otherwise be
 * reported as a climb out of it.
 *
 * // Usage: const file = reportWorkdirRelativePath(absolute, options);
 */
export function reportWorkdirRelativePath(
  resolvedPath: string,
  options: WorkdirResolutionOptions
): string {
  const { paths } = options;
  const workdir = options.workdirPolicy?.root ?? options.workdir;
  if (!workdir) return resolvedPath;

  const base = expandHome(workdir, paths);
  if (!paths.isAbsolute(base)) return resolvedPath;

  const root = paths.canonical(base);
  if (!paths.contains(root, resolvedPath)) return resolvedPath;
  // The working directory itself relativizes to `''`, which no tool accepts.
  return paths.relative(root, resolvedPath) || '.';
}

export function resolveAndValidatePath(inputPath: string, options: ResolvePathOptions): string {
  const resolved = resolveWorkdirRelativePath(inputPath, options);
  const { settings, paths } = options;

  const allowedRoots = enabledRoots(settings.allowedPaths, options);
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => paths.contains(root, resolved))) {
    throw new PathAccessError(`Path "${inputPath}" is not in the allowed paths.`);
  }

  const deniedRoots = enabledRoots(settings.deniedPaths, options);
  if (deniedRoots.some((root) => paths.contains(root, resolved))) {
    throw new PathAccessError(`Path "${inputPath}" is in the denied paths.`);
  }

  assertWorkdirContainment(resolved, options);
  return resolved;
}

/**
 * The policy every filesystem call carries so the runtime can apply it to the
 * paths it reaches — the ones glob and grep discover as they walk, and the
 * link-resolved location of the ones the hub named. Omitted when nothing is
 * configured and the chat is not pinned, so an unrestricted call stays one.
 */
export function runtimePathPolicy(options: ResolvePathOptions): RuntimePathPolicyParams {
  const { settings, workdirPolicy, paths } = options;
  const allowedRoots = enabledRoots(settings.allowedPaths, options);
  const deniedRoots = enabledRoots(settings.deniedPaths, options);
  const containmentRoot = workdirPolicy?.restricted
    ? paths.canonical(expandHome(workdirPolicy.root, paths))
    : undefined;
  if (allowedRoots.length === 0 && deniedRoots.length === 0 && !containmentRoot) return {};

  const pathPolicy: RuntimePathFilter = {
    allowedRoots,
    deniedRoots,
    ...(containmentRoot ? { containmentRoot } : {}),
  };
  return { pathPolicy };
}

function enabledRoots(paths: readonly PathListItem[], options: WorkdirResolutionOptions): string[] {
  return paths
    .filter((item) => item.enabled)
    .map((item) => resolveWorkdirRelativePath(item.path, options));
}
