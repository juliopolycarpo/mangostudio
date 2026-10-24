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
  const result = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = result.stdout.toString().trim();
  const error = result.stderr.toString().trim();
  if (result.exitCode === 1 && output === '' && error === '') return undefined;
  if (result.exitCode !== 0 || !/^\S+$/.test(output)) {
    throw new Error(
      `process ${pid}: expected readable process state | received: exit ${result.exitCode}, ${JSON.stringify(output)}, ${JSON.stringify(error)}`
    );
  }
  return output.slice(0, 1);
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
