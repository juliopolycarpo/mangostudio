/** Per-PID test oracle, independent of production descendant and token discovery. */
import { readFileSync } from 'node:fs';

export type ProcessStateTable = (pid: number) => string | undefined;

export type ProcessStatReader = (path: string, encoding: 'utf8') => string;

/**
 * Read one PID's native state; missing processes are absent and query errors surface.
 *
 * @example
 * const state = readProcessState(child.pid); // e.g. "S", "Z", or undefined
 */
export function readProcessState(
  pid: number,
  readStat: ProcessStatReader = readFileSync
): string | undefined {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return 'R';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
      throw error;
    }
  }
  if (process.platform === 'linux') {
    try {
      const stat = readStat(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return undefined;
      throw error;
    }
  }
  return readPsProcessState(pid);
}

/** One `ps -o stat= -p <pid>` answer. */
export interface PsStateAnswer {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type PsStateQuery = (pid: number) => PsStateAnswer;

const queryPsState: PsStateQuery = (pid) => {
  const result = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

/** Rereads of a transitional `?` state before it is reported: 40 x 5 ms. */
export const TRANSITIONAL_STATE_READS = 40;
const TRANSITIONAL_STATE_PAUSE_MS = 5;

/**
 * Read one PID's state through `ps`, the reader for POSIX hosts without /proc.
 *
 * macOS `ps` prints `?` when it cannot read a state for the process's threads,
 * which happens while the process is being created or torn down. That answer
 * describes the instant, not the process, so it is read again until `ps`
 * reports a letter or the process is gone. A `?` that outlasts the rereads is
 * returned as is, and {@link isAlive} refuses it.
 *
 * @example
 * const state = readPsProcessState(child.pid); // e.g. "S", "Z", or undefined
 */
export function readPsProcessState(
  pid: number,
  query: PsStateQuery = queryPsState,
  pause: (milliseconds: number) => void = (milliseconds) => Bun.sleepSync(milliseconds)
): string | undefined {
  for (let read = 1; ; read++) {
    const result = query(pid);
    const output = result.stdout.trim();
    const error = result.stderr.trim();
    if (result.exitCode === 1 && output === '' && error === '') return undefined;
    if (result.exitCode !== 0 || !/^\S+$/.test(output)) {
      throw new Error(
        `process ${pid}: expected readable process state | received: exit ${result.exitCode}, ${JSON.stringify(output)}, ${JSON.stringify(error)}`
      );
    }
    const state = output.slice(0, 1);
    if (state !== '?' || read >= TRANSITIONAL_STATE_READS) return state;
    pause(TRANSITIONAL_STATE_PAUSE_MS);
  }
}

/**
 * Count live processes while excluding unreaped zombies; refuse unknown states.
 *
 * @example
 * const survivors = pids.filter((pid) => isAlive(pid));
 */
export const isAlive = (pid: number, table: ProcessStateTable = readProcessState): boolean => {
  const state = table(pid);
  if (state === undefined) return false;
  if (!/^[RSDZTWXIKPUt]$/.test(state)) {
    throw new Error(
      `process ${pid}: expected a process state letter | received: ${JSON.stringify(state)}`
    );
  }
  return state !== 'Z';
};
