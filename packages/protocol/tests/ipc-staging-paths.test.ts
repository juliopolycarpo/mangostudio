import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const unix = process.platform !== 'win32';

const runtimes = [
  { name: 'Bun', executable: process.execPath, scenarios: ['cwd', 'symlink'] },
  { name: 'Node', executable: Bun.which('node'), scenarios: ['cwd', 'symlink', 'worker'] },
];
for (const { name, executable, scenarios } of runtimes) {
  for (const scenario of scenarios) {
    test.skipIf(!unix || !executable)(`${name} binds and closes IPC for ${scenario}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ipc-stage-test-'));
      try {
        const result = await Bun.build({
          entrypoints: [new URL('./fixtures/ipc-staging-paths.ts', import.meta.url).pathname],
          target: 'node',
          format: 'esm',
          outdir: directory,
          naming: 'fixture.mjs',
        });
        expect(result.success).toBe(true);
        const child = Bun.spawn([executable ?? 'node', join(directory, 'fixture.mjs'), scenario], {
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: 5000,
        });
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
