import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tracer injects the same kernel result for libc and direct syscall callers.
// Other platforms retain the ordinary managed-process tests.
describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64' || !Bun.which('cc'))(
  'managed fixture recursive removal races',
  () => {
    let directory: string;
    let tracer: string;
    const roots: string[] = [];
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'mango-fixture-rm-race-'));
      tracer = join(directory, 'race');
      const source = new URL('../../support/fixtures/managed-process-rm-race.c', import.meta.url);
      const compiler = Bun.spawn(['cc', fileURLToPath(source), '-o', tracer], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const error = await new Response(compiler.stderr).text();
      expect(await compiler.exited, `native race tracer compilation: ${error}`).toBe(0);
    });
    afterAll(async () => {
      for (const root of roots) await rm(root, { force: true, recursive: true });
      if (directory) await rm(directory, { force: true, recursive: true });
    });

    async function cleanupWithRace(deny: boolean) {
      const fixtureModule = new URL('../../support/fixtures/managed-process.ts', import.meta.url);
      const child = Bun.spawn(
        [
          tracer,
          deny ? 'EACCES' : 'ENOENT',
          process.execPath,
          '-e',
          `import { createManagedProcessFixture } from ${JSON.stringify(fileURLToPath(fixtureModule))};
          import { existsSync } from 'node:fs';
          const fixture = await createManagedProcessFixture({tempPrefix: 'mango-native-rm-race-'});
          console.log(fixture.tempDir);
          await Bun.write(fixture.tempDir + '/raced-child', '');
          await Bun.write(fixture.tempDir + '/remaining-child', '');
          await fixture.cleanup();
          console.log('root exists: ' + existsSync(fixture.tempDir));`,
        ],
        {
          env: process.env,
          timeout: 10_000,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const root = stdout.split('\n')[0];
      if (root) roots.push(root);
      return { stdout, stderr, exitCode, root };
    }

    it('removes the whole root when a child disappears during unlink', async () => {
      const result = await cleanupWithRace(false);
      expect(result.stderr).toContain('injected child ENOENT');
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('root exists: false');
    });

    it('preserves removal errors and residual diagnostics for a denied child', async () => {
      const result = await cleanupWithRace(true);
      expect(result.stderr).toContain('injected child EACCES');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Fixture cleanup failed');
      expect(result.stderr).toContain('EACCES');
      expect(result.stderr).toContain('residual paths:');
      expect(result.stderr).toContain('raced-child');
      expect(existsSync(join(result.root ?? '', 'raced-child'))).toBe(true);
    });
  }
);
