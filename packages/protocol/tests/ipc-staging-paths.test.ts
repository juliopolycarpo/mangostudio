import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const unix = process.platform !== 'win32';

// The fixture finishes in about 150 ms. A macOS runner once took over 5 s and
// the child was killed by the spawn timeout, which read as a fixture failure
// (exit 143). The budget is sized to tell a stalled host from a fixture that
// never closes its channel, and the assertion names which one happened.
const FIXTURE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = FIXTURE_TIMEOUT_MS + 10_000;

const runtimes = [
  { name: 'Bun', executable: process.execPath, scenarios: ['cwd', 'symlink'] },
  { name: 'Node', executable: Bun.which('node'), scenarios: ['cwd', 'symlink', 'worker'] },
];
for (const { name, executable, scenarios } of runtimes) {
  for (const scenario of scenarios) {
    test.skipIf(!unix || !executable)(
      `${name} binds and closes IPC for ${scenario}`,
      async () => {
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
          const started = performance.now();
          const child = Bun.spawn(
            [executable ?? 'node', join(directory, 'fixture.mjs'), scenario],
            {
              stdout: 'ignore',
              stderr: 'pipe',
              timeout: FIXTURE_TIMEOUT_MS,
            }
          );
          const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          const elapsedMs = Math.round(performance.now() - started);
          expect(
            { exitCode, signal: child.signalCode, stderr },
            `expected fixture exit: 0 within ${FIXTURE_TIMEOUT_MS} ms | received: exit ${exitCode}, signal ${child.signalCode} after ${elapsedMs} ms`
          ).toEqual({ exitCode: 0, signal: null, stderr: '' });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS
    );
  }
}
