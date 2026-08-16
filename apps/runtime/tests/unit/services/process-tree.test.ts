import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  killProcessTree,
  OWN_PROCESS_GROUP,
  startWindowsTaskkillTree,
  windowsTaskkillArguments,
} from '../../../src/services/process-tree';
import { HIDDEN_WINDOW } from '../../../src/services/process-window';
import { waitUntilGone } from './support/process-lifetime';

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });
  }
  return buffer.split('\n')[0]?.trim() ?? '';
}

describe('killProcessTree', () => {
  it.skipIf(process.platform === 'win32')(
    "reaps a live leader's descendants instead of leaving them as PID 1 zombies",
    async () => {
      const proc = Bun.spawn(['bash', '-c', 'sleep 60 & echo $!; sleep 60'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        ...OWN_PROCESS_GROUP,
        ...HIDDEN_WINDOW,
      });
      const leaderPid = proc.pid;
      expect(leaderPid).toBeGreaterThan(1);

      const descendant = Number(await readFirstLine(proc.stdout));
      expect(Number.isFinite(descendant)).toBe(true);
      expect(descendant).toBeGreaterThan(1);

      killProcessTree(leaderPid, () => proc.kill('SIGKILL'));
      await proc.exited;

      expect(await waitUntilGone(descendant, 10_000)).toBe(true);
      expect(await waitUntilGone(leaderPid, 10_000)).toBe(true);
    },
    20_000
  );

  it.skipIf(process.platform !== 'linux' || Bun.which('setsid') === null)(
    'reaps a descendant that left the process group',
    async () => {
      const proc = Bun.spawn(
        ['bash', '-c', 'setsid sleep 60 >/dev/null 2>&1 & echo $!; sleep 60'],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          ...OWN_PROCESS_GROUP,
          ...HIDDEN_WINDOW,
        }
      );
      const leaderPid = proc.pid;
      expect(leaderPid).toBeGreaterThan(1);

      const descendant = Number(await readFirstLine(proc.stdout));
      expect(Number.isFinite(descendant)).toBe(true);
      expect(descendant).toBeGreaterThan(1);
      const leftGroup = await waitUntil(() => {
        const pgid = linuxPgid(descendant);
        return pgid !== null && pgid !== leaderPid;
      }, 2_000);
      expect(leftGroup).toBe(true);

      killProcessTree(leaderPid, () => proc.kill('SIGKILL'));
      await proc.exited;

      expect(await waitUntilGone(descendant, 10_000)).toBe(true);
      expect(await waitUntilGone(leaderPid, 10_000)).toBe(true);
    },
    20_000
  );
});

function fakeTaskkillProcess() {
  const child = new EventEmitter();
  return Object.assign(child, {
    unref: () => child,
    kill: () => child,
  });
}

function linuxPgid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).split(' ');
    const pgid = Number(fields[2]);
    return Number.isSafeInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

async function waitUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

describe('startWindowsTaskkillTree', () => {
  it('starts taskkill without killing the root so /T can still see descendants', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const taskkill = fakeTaskkillProcess();
    let directKilled = false;

    startWindowsTaskkillTree(
      42,
      () => {
        directKilled = true;
      },
      (command, args) => {
        calls.push({ command, args });
        return taskkill;
      }
    );

    expect(calls).toEqual([{ command: 'taskkill', args: [...windowsTaskkillArguments(42)] }]);
    expect(directKilled).toBe(false);
    taskkill.emit('close', 0);
  });

  it('kills the direct child only when taskkill cannot start', () => {
    let directKilled = false;

    startWindowsTaskkillTree(
      42,
      () => {
        directKilled = true;
      },
      () => {
        throw new Error('taskkill is not on PATH');
      }
    );

    expect(directKilled).toBe(true);
  });

  it('kills the direct child when the started taskkill fails', () => {
    const taskkill = fakeTaskkillProcess();
    let directKilled = false;

    startWindowsTaskkillTree(
      42,
      () => {
        directKilled = true;
      },
      () => taskkill
    );

    taskkill.emit('error', new Error('taskkill refused'));
    expect(directKilled).toBe(true);
  });

  it('kills the direct child when taskkill never settles', async () => {
    const taskkill = fakeTaskkillProcess();
    let directKilled = false;
    let killedTaskkill = false;
    Object.assign(taskkill, {
      kill: () => {
        killedTaskkill = true;
        return taskkill;
      },
    });

    startWindowsTaskkillTree(
      42,
      () => {
        directKilled = true;
      },
      () => taskkill,
      0
    );

    expect(directKilled).toBe(false);
    await Bun.sleep(20);
    expect(killedTaskkill).toBe(true);
    expect(directKilled).toBe(true);
  });

  it('does not kill the direct child when taskkill exits 0 before the deadline', async () => {
    const taskkill = fakeTaskkillProcess();
    let directKilled = false;

    startWindowsTaskkillTree(
      42,
      () => {
        directKilled = true;
      },
      () => taskkill,
      0
    );

    taskkill.emit('close', 0);
    await Bun.sleep(20);
    expect(directKilled).toBe(false);
  });
});
