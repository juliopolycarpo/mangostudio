import type { Dirent } from 'node:fs';
import { access, constants, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type {
  DirectoryEntry,
  ListDirectoryResponse,
  WorkdirValidationReason,
} from '@mangostudio/shared/workspaces';
import { RuntimeServiceError } from '../errors';
import type {
  RuntimeWorkspaceBrowseParams,
  RuntimeWorkspaceResolveContainedParams,
  RuntimeWorkspaceResolveContainedResult,
  RuntimeWorkspaceValidateResult,
} from '../methods';
import { resolveWorkspacePath, WorkspacePathError } from './workspace-path';

/** Protocol-layer cap on directory listing size. */
export const MAX_WORKSPACE_DIRECTORY_ENTRIES = 5000;

/** Reused across comparisons; constructing a collator per compare dominates large listings. */
const INSENSITIVE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
const CASE_COLLATOR = new Intl.Collator();

const BROWSER_REASON_MESSAGES: Record<WorkdirValidationReason | 'invalid-path', string> = {
  'invalid-path': 'Directory browsing requires an absolute path.',
  'not-found': 'The requested directory does not exist.',
  'not-a-directory': 'The requested path is not a directory.',
  'permission-denied': 'The server cannot access the requested directory.',
};

export class WorkspaceBrowserError extends RuntimeServiceError {
  constructor(
    readonly code: 'VALIDATION' | 'FILESYSTEM',
    readonly reason: WorkdirValidationReason | 'invalid-path'
  ) {
    super('workspace_browser', BROWSER_REASON_MESSAGES[reason], { code, reason });
    this.name = 'WorkspaceBrowserError';
  }
}

function filesystemReason(error: unknown): WorkdirValidationReason | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }

  switch (error.code) {
    case 'ENOENT':
      return 'not-found';
    case 'ENOTDIR':
      return 'not-a-directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    default:
      return undefined;
  }
}

async function isDirectoryEntry(
  path: string,
  directoryEntry: { isDirectory(): boolean; isSymbolicLink(): boolean }
): Promise<boolean> {
  if (directoryEntry.isDirectory()) {
    return true;
  }
  if (!directoryEntry.isSymbolicLink()) {
    return false;
  }

  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

let cachedRoots: Promise<string[]> | undefined;

async function probeWindowsDrives(): Promise<string[]> {
  const candidates = Array.from(
    { length: 26 },
    (_, index) => `${String.fromCharCode(65 + index)}:\\`
  );
  const roots = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate);
        return candidate;
      } catch {
        return undefined;
      }
    })
  );
  return roots.filter((root): root is string => root !== undefined);
}

/**
 * Mounted roots change rarely but probing them costs 26 syscalls on Windows,
 * so the result is resolved once and shared by every listing.
 */
function listFilesystemRoots(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return Promise.resolve(['/']);
  }
  cachedRoots ??= probeWindowsDrives();
  return cachedRoots;
}

export async function browseWorkspace(
  params: RuntimeWorkspaceBrowseParams = {}
): Promise<ListDirectoryResponse> {
  const path = params.path ?? homedir();
  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(path, { requireAbsolute: true });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw new WorkspaceBrowserError('VALIDATION', 'invalid-path');
    }
    throw error;
  }

  let rawEntries: Dirent[];
  try {
    rawEntries = await readdir(resolvedPath, { withFileTypes: true });
  } catch (error) {
    const reason = filesystemReason(error);
    if (reason) {
      throw new WorkspaceBrowserError('FILESYSTEM', reason);
    }
    throw error;
  }

  const entries = (
    await Promise.all(
      rawEntries.map(async (entry): Promise<DirectoryEntry | undefined> => {
        const entryPath = resolve(resolvedPath, entry.name);
        if (!(await isDirectoryEntry(entryPath, entry))) {
          return undefined;
        }
        return {
          name: entry.name,
          path: entryPath,
          hidden: entry.name.startsWith('.'),
        };
      })
    )
  )
    .filter((entry): entry is DirectoryEntry => entry !== undefined)
    .sort((left, right) => {
      const insensitiveOrder = INSENSITIVE_COLLATOR.compare(left.name, right.name);
      return insensitiveOrder || CASE_COLLATOR.compare(left.name, right.name);
    });

  const truncated = entries.length > MAX_WORKSPACE_DIRECTORY_ENTRIES;
  const cappedEntries = truncated ? entries.slice(0, MAX_WORKSPACE_DIRECTORY_ENTRIES) : entries;

  const root = parse(resolvedPath).root;
  return {
    path: resolvedPath,
    parent: resolvedPath === root ? null : dirname(resolvedPath),
    entries: cappedEntries,
    home: homedir(),
    roots: await listFilesystemRoots(),
    separator: sep as '/' | '\\',
    ...(truncated ? { truncated: true } : {}),
  };
}

export class WorkspaceContainmentError extends RuntimeServiceError {
  constructor(readonly requestedPath: string) {
    super('workspace_containment', `Invalid repository path: ${requestedPath}`, {
      requestedPath,
    });
    this.name = 'WorkspaceContainmentError';
  }
}

/**
 * Resolves a root-relative path to its real location and re-checks containment
 * after following symlinks. Runs runtime-side because both halves are host
 * facts: `realpath` reads the filesystem that owns the root, and separator
 * normalization must follow that host's path style, not the hub's.
 *
 * Returns null when nothing exists at the location — callers treat that as
 * "no content to read" rather than an escape.
 */
export async function resolveContainedWorkspacePath(
  params: RuntimeWorkspaceResolveContainedParams
): Promise<RuntimeWorkspaceResolveContainedResult> {
  const realRoot = await realpath(resolve(params.root));

  let realPath: string;
  try {
    // Both separators are treated as boundaries so a foreign-style path from the
    // hub resolves the same way it would natively.
    realPath = await realpath(resolve(realRoot, params.path.replaceAll('\\', '/')));
  } catch {
    return { relativePath: null };
  }

  const relativePath = relative(realRoot, realPath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new WorkspaceContainmentError(params.path);
  }
  return { relativePath };
}

export async function validateWorkdir(
  path: string,
  options?: { requireAbsolute?: boolean }
): Promise<RuntimeWorkspaceValidateResult> {
  const resolvedPath = resolveWorkspacePath(path, options);

  try {
    const metadata = await stat(resolvedPath);
    if (!metadata.isDirectory()) {
      return { ok: false, reason: 'not-a-directory' };
    }

    await access(resolvedPath, constants.R_OK | constants.X_OK);
    return { ok: true, resolvedPath };
  } catch (error) {
    const reason = filesystemReason(error);
    if (reason) {
      return { ok: false, reason };
    }
    throw error;
  }
}
