import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { earliestListenerHello, prebufferedAcceptedHello } from './fixtures/ipc-buffered-hello';

const UNIX = process.platform !== 'win32';

test.skipIf(!UNIX)(
  'a real accepted socket buffers hello before the port subscribers are installed',
  async () => {
    await prebufferedAcceptedHello();
  }
);

test.skipIf(!UNIX)('listenIpc receives the earliest client hello', async () => {
  await earliestListenerHello();
});

test.skipIf(!UNIX || Bun.which('node') === null)(
  'native Node delivers buffered and earliest hello to both subscribers',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ipc-h-node-'));
    try {
      const result = await Bun.build({
        entrypoints: [new URL('./fixtures/ipc-buffered-hello-node.ts', import.meta.url).pathname],
        target: 'node',
        format: 'esm',
        outdir: directory,
        naming: 'fixture.mjs',
      });
      expect(result.success).toBe(true);
      const child = Bun.spawn([Bun.which('node') ?? 'node', join(directory, 'fixture.mjs')], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
      expect(stdout).toContain('passed: prebuffered and earliest peer hello on native Node');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
