import { readdir, readFile } from 'node:fs/promises';

import { parseLinuxProcessResourceStat, type ProcessResourceRow } from './process-resource-sample';

export interface ProcessResourceUnits {
  readonly pageBytes: number;
  readonly ticksPerSecond: number;
}

function getconf(name: string): string {
  const result = Bun.spawnSync(['getconf', name], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(
      `getconf ${name}: expected exit 0 | received: ${result.exitCode}: ${result.stderr.toString().trim()}`
    );
  }
  return result.stdout.toString().trim();
}

function positiveUnit(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `getconf ${name}: expected a positive safe integer | received: ${JSON.stringify(value)}`
    );
  }
  return parsed;
}

/** Resolves procfs page/CPU counter units before a timed workload. Example: linuxProcessResourceUnits(). */
export function linuxProcessResourceUnits(
  capture: (name: string) => string = getconf
): ProcessResourceUnits {
  return {
    pageBytes: positiveUnit(capture('PAGESIZE'), 'PAGESIZE'),
    ticksPerSecond: positiveUnit(capture('CLK_TCK'), 'CLK_TCK'),
  };
}

export interface ProcessResourceFiles {
  readonly names: () => Promise<readonly string[]>;
  readonly stat: (pid: number) => Promise<string>;
}

const PROC_FILES: ProcessResourceFiles = {
  names: () => readdir('/proc'),
  stat: (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
};

async function readLiveRow(
  pid: number,
  pageBytes: number,
  files: ProcessResourceFiles
): Promise<ProcessResourceRow | null> {
  try {
    return parseLinuxProcessResourceStat(pid, await files.stat(pid), pageBytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
}

/**
 * Reads one Linux process-resource census; only normal exit races are omitted.
 * Example: const processes = await readLinuxProcessResources(4096).
 */
export async function readLinuxProcessResources(
  pageBytes: number,
  files: ProcessResourceFiles = PROC_FILES
): Promise<ProcessResourceRow[]> {
  const names = (await files.names()).filter((name) => /^[1-9]\d*$/.test(name));
  const rows = await Promise.all(names.map((name) => readLiveRow(Number(name), pageBytes, files)));
  return rows.filter((row): row is ProcessResourceRow => row !== null);
}
