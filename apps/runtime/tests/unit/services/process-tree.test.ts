import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
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
});

function fakeTaskkillProcess() {
  const child = new EventEmitter();
  return Object.assign(child, { unref: () => child });
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
});
