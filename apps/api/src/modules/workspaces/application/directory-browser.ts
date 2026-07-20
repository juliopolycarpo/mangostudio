import type { Dirent } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, parse, resolve, sep } from 'node:path';
import type {
  DirectoryEntry,
  ListDirectoryResponse,
  WorkdirValidationReason,
} from '@mangostudio/shared/workspaces';
import { resolveWorkspacePath, WorkspacePathError } from './workspace-path';

/** Reused across comparisons; constructing a collator per compare dominates large listings. */
const INSENSITIVE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
const CASE_COLLATOR = new Intl.Collator();

const REASON_MESSAGES: Record<WorkdirValidationReason | 'invalid-path', string> = {
  'invalid-path': 'Directory browsing requires an absolute path.',
  'not-found': 'The requested directory does not exist.',
  'not-a-directory': 'The requested path is not a directory.',
  'permission-denied': 'The server cannot access the requested directory.',
};

export class DirectoryBrowserError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'FILESYSTEM',
    readonly reason: WorkdirValidationReason | 'invalid-path'
  ) {
    super(REASON_MESSAGES[reason]);
    this.name = 'DirectoryBrowserError';
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

export async function listDirectory(path = homedir()): Promise<ListDirectoryResponse> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(path, { requireAbsolute: true });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw new DirectoryBrowserError('VALIDATION', 'invalid-path');
    }
    throw error;
  }

  let rawEntries: Dirent[];
  try {
    rawEntries = await readdir(resolvedPath, { withFileTypes: true });
  } catch (error) {
    const reason = filesystemReason(error);
    if (reason) {
      throw new DirectoryBrowserError('FILESYSTEM', reason);
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

  const root = parse(resolvedPath).root;
  return {
    path: resolvedPath,
    parent: resolvedPath === root ? null : dirname(resolvedPath),
    entries,
    home: homedir(),
    roots: await listFilesystemRoots(),
    separator: sep,
  };
}
