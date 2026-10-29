import { describe, expect, test } from 'bun:test';

import { readLinuxSmokeProcesses, type SmokeProcFiles } from '../lib/binary-smoke-linux';

/** A procfs fixture includes children created from a non-leader hub thread. */
class FakeSmokeProc implements SmokeProcFiles {
  readonly paths: string[] = [];
  readonly content = new Map<string, string>();
  readonly tasks = new Map<string, string[]>();
  constructor() {
    this.process(42, 1, '100', ['42', '43']);
    this.process(44, 42, '101', ['44']);
    this.content.set('/proc/42/task/43/children', '44');
  }
  process(pid: number, parent: number, ticks: string, tasks: string[]): void {
    this.content.set(
      `/proc/${pid}/stat`,
      `${pid} (hub with spaces) S ${parent} 42 ${Array(16).fill('0').join(' ')} ${ticks} 0`
    );
    this.tasks.set(`/proc/${pid}/task`, tasks);
    for (const task of tasks) this.content.set(`/proc/${pid}/task/${task}/children`, '');
  }
  read = (path: string): Promise<string> => {
    this.paths.push(path);
    const value = this.content.get(path);
    return value === undefined
      ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      : Promise.resolve(value);
  };
  list = (path: string): Promise<string[]> => Promise.resolve(this.tasks.get(path) ?? []);
}

describe('targeted Linux smoke process reads', () => {
  test('follows all threads and deduplicates an already observed child without reading unrelated PIDs', async () => {
    const files = new FakeSmokeProc();
    const rows = await readLinuxSmokeProcesses(
      [{ pid: 42 }, { pid: 44, identity: '44:101' }],
      files
    );
    expect(rows.map((row) => row.identity)).toEqual(['42:100', '44:101']);
    expect(files.paths.filter((path) => path === '/proc/44/stat')).toHaveLength(1);
    expect(files.paths).not.toContain('/proc/1/stat');
  });
  test('does not follow a reused PID or treat a gone process as alive', async () => {
    const files = new FakeSmokeProc();
    expect(
      await readLinuxSmokeProcesses([{ pid: 42, identity: '42:99' }, { pid: 999 }], files)
    ).toEqual([]);
    expect(files.paths).not.toContain('/proc/44/stat');
  });
  test('surfaces an incomplete census instead of claiming settlement', async () => {
    const files = new FakeSmokeProc();
    files.content.set('/proc/42/stat', 'invalid stat');
    await expect(readLinuxSmokeProcesses([{ pid: 42 }], files)).rejects.toThrow(
      'expected decimal digits'
    );
  });
});
