import { readdir, readFile } from 'node:fs/promises';

import { type NativeProcess, readLinuxProcessIdentity } from './native-bun-qualification-process';

export interface SmokeProcFiles {
  read(path: string, encoding: 'utf8'): Promise<string>;
  list(path: string): Promise<string[]>;
}

/**
 * Read only the owned hub/observed PIDs and their children, without depending on GNU ps in musl images.
 * Recorded start identities prevent a reused PID from granting ownership of its new descendants.
 * @example const rows = await readLinuxSmokeProcesses([{ pid: child.pid }]);
 */
export async function readLinuxSmokeProcesses(
  seeds: readonly { pid: number; identity?: string }[],
  files: SmokeProcFiles = { read: readFile, list: readdir }
): Promise<NativeProcess[]> {
  const queue = [...seeds];
  const seen = new Set<number>();
  const rows: NativeProcess[] = [];
  for (const seed of queue) {
    if (seen.has(seed.pid)) continue;
    seen.add(seed.pid);
    const row = await readLinuxProcessIdentity(
      { pid: seed.pid, parentPid: 0, group: null, identity: '', command: '' },
      files.read
    );
    if (!row || (seed.identity !== undefined && row.identity !== seed.identity)) continue;
    rows.push(row);
    try {
      const tasks = await files.list(`/proc/${row.pid}/task`);
      for (const task of tasks) {
        const children = await files.read(`/proc/${row.pid}/task/${task}/children`, 'utf8');
        queue.push(
          ...children
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((pid) => ({ pid: Number(pid) }))
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  return rows;
}
