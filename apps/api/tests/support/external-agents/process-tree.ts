/**
 * Finds the vendor process a runtime started, so a live case can end exactly that one.
 *
 * A runtime hosts the vendor CLI under a helper process, so the vendor is a grandchild of the pid
 * the test spawned. The walk starts at that pid and matches by executable path, which keeps a vendor
 * process of the same program that the test did not start (the developer's own session) out of reach.
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** One process of a point-in-time snapshot. */
export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  /** The resolved executable path; absent when the process is gone or unreadable. */
  readonly executable?: string;
}

/**
 * Every pid in `snapshot` that descends from `rootPid`, nearest first, without `rootPid` itself.
 *
 * @example
 * descendantsOf(100, [{ pid: 101, parentPid: 100 }, { pid: 102, parentPid: 101 }]); // [101, 102]
 */
export function descendantsOf(rootPid: number, snapshot: readonly ProcessEntry[]): number[] {
  const found: number[] = [];
  let frontier = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const entry of snapshot) {
      if (seen.has(entry.pid) || !frontier.includes(entry.parentPid)) continue;
      seen.add(entry.pid);
      found.push(entry.pid);
      next.push(entry.pid);
    }
    frontier = next;
  }
  return found;
}

/**
 * The descendants of `rootPid` whose executable is `executable`.
 *
 * @example
 * vendorProcessesOf(100, '/home/ada/.codex/bin/codex', snapshot); // [4242]
 */
export function vendorProcessesOf(
  rootPid: number,
  executable: string,
  snapshot: readonly ProcessEntry[]
): number[] {
  const owned = new Set(descendantsOf(rootPid, snapshot));
  return snapshot
    .filter((entry) => owned.has(entry.pid) && entry.executable === executable)
    .map((entry) => entry.pid);
}

/**
 * The parent pid out of a `/proc/<pid>/stat` line. The command name sits in parentheses and may
 * contain spaces and parentheses, so the fields are read after the last closing one.
 *
 * @example
 * parentPidFromStat('42 (codex app) S 7 42 42 0 -1'); // 7
 */
export function parentPidFromStat(stat: string): number {
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(' ');
  const parent = Number(rest[1]);
  if (!Number.isInteger(parent)) {
    throw new Error(`expected a /proc stat line with a numeric parent pid | received: ${stat}`);
  }
  return parent;
}

/**
 * A Linux-only snapshot of this machine's processes from `/proc`. A process that exits while it
 * is read is left out.
 *
 * @example
 * vendorProcessesOf(runtimePid, codexPath, readProcessSnapshot());
 */
export function readProcessSnapshot(): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const parentPid = parentPidFromStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
      let executable: string | undefined;
      try {
        executable = readlinkSync(`/proc/${name}/exe`);
      } catch {
        executable = undefined;
      }
      entries.push({
        pid: Number(name),
        parentPid,
        ...(executable ? { executable } : {}),
      });
    } catch {
      // Gone between the listing and the read.
    }
  }
  return entries;
}
