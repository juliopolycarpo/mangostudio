import { describe, expect, it } from 'bun:test';
import { killProcessTree, OWN_PROCESS_GROUP } from '../../../src/services/process-tree';
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
