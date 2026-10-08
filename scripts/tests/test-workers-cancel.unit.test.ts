/**
 * Cancelling the integration lane mid-run, through the real stack: a root runner
 * (`runCommand`, which owns process groups and exits 128 + signal) starts the
 * worker runner's real `main`, whose workers are stand-ins for `bun test` that
 * hang and keep a child of their own. The root runner is signalled; nothing may
 * survive it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { FAKE_LANE_MAIN } from './support/fake-lane-main';
import { FAKE_ROOT_RUNNER } from './support/fake-root-runner';

const API_DIR = join(ROOT_DIR, 'apps', 'api');
const dirs: string[] = [];
const pidsToReap: number[] = [];

afterEach(() => {
  for (const pid of pidsToReap.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone, as it should be
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await Bun.sleep(25);
  }
  return ready();
}

/** Starts `command` with the fake lane environment: three hanging workers, each with a child. */
function startLane(command: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-cancel-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'pids'));
  const child = Bun.spawn({
    cmd: [...command],
    cwd: API_DIR,
    env: {
      ...process.env,
      MANGO_TEST_WORKERS: '3',
      MANGOSTUDIO_FAKE_WORKER_MODES: JSON.stringify({
        1: 'hang-tree',
        2: 'hang-tree',
        3: 'hang-tree',
      }),
      MANGOSTUDIO_FAKE_PID_DIR: join(dir, 'pids'),
      MANGOSTUDIO_FAKE_MERGED_PATH: join(dir, 'merged.xml'),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  pidsToReap.push(child.pid);
  const pidFiles = () => readdirSync(join(dir, 'pids')).sort();
  const pids = (): number[] =>
    pidFiles().map((name) => Number(readFileSync(join(dir, 'pids', name), 'utf8')));
  return { child, pids, pidFiles };
}

describe.skipIf(process.platform === 'win32')('cancelling the integration lane mid-run', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`leaves nothing running when the root runner gets ${signal}`, async () => {
      const lane = startLane([
        process.execPath,
        FAKE_ROOT_RUNNER,
        process.execPath,
        FAKE_LANE_MAIN,
      ]);
      const up = await until(() => lane.pidFiles().length === 6, 30_000);
      const pids = lane.pids();
      pidsToReap.push(...pids);
      expect(
        up,
        `expected 3 workers and 3 children running | received files: ${lane.pidFiles()}`
      ).toBe(true);
      expect(
        pids.filter(isAlive),
        'expected every worker and child alive before the cancel'
      ).toHaveLength(6);

      lane.child.kill(signal);
      const exitCode = await lane.child.exited;

      const expected = signal === 'SIGTERM' ? 143 : 130;
      expect(exitCode, `expected the root runner to exit 128 + ${signal}: ${expected}`).toBe(
        expected
      );
      const survivors = pids.filter(isAlive);
      expect(
        survivors,
        `expected live descendants: 0 | received: ${survivors.length} (pids ${survivors})`
      ).toEqual([]);
    });
  }

  it('leaves nothing running when the worker runner itself gets SIGTERM', async () => {
    const lane = startLane([process.execPath, FAKE_LANE_MAIN]);
    const up = await until(() => lane.pidFiles().length === 6, 30_000);
    const pids = lane.pids();
    pidsToReap.push(...pids);
    expect(
      up,
      `expected 3 workers and 3 children running | received files: ${lane.pidFiles()}`
    ).toBe(true);

    lane.child.kill('SIGTERM');
    const exitCode = await lane.child.exited;

    expect(exitCode).toBe(143);
    const survivors = pids.filter(isAlive);
    expect(
      survivors,
      `expected live descendants: 0 | received: ${survivors.length} (pids ${survivors})`
    ).toEqual([]);
  });
});
