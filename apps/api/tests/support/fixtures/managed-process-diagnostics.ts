import { type BigIntStats, type Dirent, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  descendantsOf,
  type ProcessEntry,
  readProcessSnapshot,
} from '../external-agents/process-tree';

type RootIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'isDirectory'>;
const MAX_RESIDUAL_PATHS = 32;
const MAX_RESIDUAL_DEPTH = 4;
const MAX_PROCESS_ENTRIES = 32;
const MAX_DIAGNOSTIC_LENGTH = 16 * 1024;

export function readRootIdentity(path: string): RootIdentity | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Observations only: diagnosing descendants does not grant ownership of them.
 * @example const diagnostics = createReleaseDiagnostics(fixture.tempDir);
 */
export function createReleaseDiagnostics(
  tempDir: string,
  io: {
    readProcessSnapshot?: () => ProcessEntry[];
    readDirectory?: (path: string) => Dirent[];
  } = {}
) {
  const allocatedRoot = readRootIdentity(tempDir);
  let beforeRemoval: RootIdentity | null | undefined;
  const observedDescendants = new Map<number, ProcessEntry>();
  let processSnapshotError: unknown;

  const observeProcesses = (child: Bun.Subprocess | null): ProcessEntry[] => {
    if (!child || process.platform !== 'linux') return [];
    try {
      const snapshot = (io.readProcessSnapshot ?? readProcessSnapshot)();
      const descendants = new Set(descendantsOf(child.pid, snapshot));
      for (const entry of snapshot) {
        if (descendants.has(entry.pid)) observedDescendants.set(entry.pid, entry);
      }
      return snapshot;
    } catch (error) {
      processSnapshotError = error;
      return [];
    }
  };

  return {
    observeProcesses,
    beforeRemoval() {
      beforeRemoval = readRootIdentity(tempDir);
    },
    describe(child: Bun.Subprocess | null): string {
      const lines = [
        `temp directory: ${tempDir}`,
        `allocated root: ${formatIdentity(allocatedRoot)}`,
        `root before removal: ${beforeRemoval === undefined ? '<not reached>' : formatIdentity(beforeRemoval)}`,
      ];
      try {
        const current = readRootIdentity(tempDir);
        lines.push(`current root: ${formatIdentity(current)}`);
        if (current && allocatedRoot) {
          lines.push(
            current.dev === allocatedRoot.dev && current.ino === allocatedRoot.ino
              ? 'root has the same dev/inode as allocated (preserved or inode reused)'
              : 'root has different dev/inode from allocated (replaced)'
          );
        }
        if (current) {
          lines.push(
            ...(current.isDirectory()
              ? residualPaths(tempDir, io.readDirectory)
              : ['root is not a directory'])
          );
        }
      } catch (error) {
        lines.push(`root inspection failed: ${error}`);
      }

      lines.push(
        child
          ? `child: pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode}`
          : 'child: <not spawned>'
      );
      const snapshot = observeProcesses(child);
      if (child && process.platform !== 'linux') {
        lines.push(`descendant snapshot unavailable on ${process.platform}`);
      } else {
        if (processSnapshotError) lines.push(`descendant snapshot failed: ${processSnapshotError}`);
        const present = new Map(snapshot.map((entry) => [entry.pid, entry]));
        lines.push('observed descendants:');
        let count = 0;
        for (const entry of observedDescendants.values()) {
          if (count >= MAX_PROCESS_ENTRIES) {
            lines.push('<process limit reached>');
            break;
          }
          const current = present.get(entry.pid);
          lines.push(
            `pid=${entry.pid} observedParent=${entry.parentPid} currentParent=${current?.parentPid ?? '<absent>'} executable=${JSON.stringify(entry.executable ?? '<unreadable>')}`
          );
          count += 1;
        }
        if (observedDescendants.size === 0) lines.push('<none observed>');
      }
      const diagnostic = lines.join('\n');
      return diagnostic.length <= MAX_DIAGNOSTIC_LENGTH
        ? diagnostic
        : `${diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH)}\n<diagnostic limit reached>`;
    },
  };
}

function formatIdentity(identity: RootIdentity | null): string {
  return identity ? `dev=${identity.dev} ino=${identity.ino}` : '<absent>';
}

/** Bounded, relative paths only; never follows symlinks or reads file contents. */
function residualPaths(
  root: string,
  readDirectory = (path: string) => readdirSync(path, { withFileTypes: true })
): string[] {
  const lines = ['residual paths:'];
  const pending = [{ path: '', depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    if (count >= MAX_RESIDUAL_PATHS) return [...lines, '<path limit reached>'];
    const directory = pending.shift();
    if (!directory) break;
    let entries: Dirent[];
    try {
      entries = readDirectory(join(root, directory.path));
    } catch (error) {
      lines.push(`directory inspection failed: ${JSON.stringify(directory.path || '.')}: ${error}`);
      count += 1;
      continue;
    }
    for (const entry of entries) {
      if (count >= MAX_RESIDUAL_PATHS) return [...lines, '<path limit reached>'];
      const path = join(directory.path, entry.name);
      lines.push(JSON.stringify(path));
      count += 1;
      if (entry.isDirectory()) {
        if (directory.depth < MAX_RESIDUAL_DEPTH) {
          pending.push({ path, depth: directory.depth + 1 });
        } else {
          if (count >= MAX_RESIDUAL_PATHS) return [...lines, '<path limit reached>'];
          lines.push('<depth limit reached>');
          count += 1;
        }
      }
    }
  }
  if (count === 0) lines.push('<empty>');
  return lines;
}
