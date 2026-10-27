import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createTailwindInputs, readSourceInventory } from '@mangostudio/shared/frontend-build/host';
import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';

import {
  publishDist,
  removeTempPaths,
  resolveApiUrlOverride,
  trackTempPath,
  writeBuildState,
} from '../../build';

describe('resolveApiUrlOverride', () => {
  test('uses MANGO_API_URL ahead of the deprecated alias', () => {
    const warnings: string[] = [];
    expect(
      resolveApiUrlOverride(
        {
          MANGO_API_URL: 'https://current.example.test',
          VITE_API_URL: 'https://deprecated.example.test',
        },
        (message) => warnings.push(message)
      )
    ).toBe('https://current.example.test');
    expect(warnings).toEqual([]);
  });

  test('supports the deprecated alias and warns when it supplies the value', () => {
    const warnings: string[] = [];
    expect(
      resolveApiUrlOverride({ VITE_API_URL: 'https://deprecated.example.test' }, (message) =>
        warnings.push(message)
      )
    ).toBe('https://deprecated.example.test');
    expect(warnings).toHaveLength(1);
  });

  test('uses an empty string when neither variable is set', () => {
    const warnings: string[] = [];
    expect(resolveApiUrlOverride({}, (message) => warnings.push(message))).toBe('');
    expect(warnings).toEqual([]);
  });
});

/**
 * Named fake for the rollback's removal of a failed bundle: refuses every call
 * the way a locked file does on Windows, and records what it was asked to
 * remove. Nothing on disk changes, so the test needs no permission tricks.
 */
class RefusingRemoval {
  readonly attempts: string[] = [];

  readonly remove = (path: string): void => {
    this.attempts.push(path);
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), {
      code: 'EBUSY',
    });
  };
}

describe('publishDist', () => {
  test('replaces the previous directory and removes files absent from the new build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');
      await writeFile(join(dist, 'old-asset.js'), 'old');

      await publishDist(staged, dist);

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('new');
      expect(existsSync(join(dist, 'old-asset.js'))).toBe(false);
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores the previous directory when publishing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const missingStaged = join(root, 'missing-staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(dist);
      await writeFile(join(dist, 'index.html'), 'old');

      await expect(publishDist(missingStaged, dist)).rejects.toThrow();

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('old');
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores the previous directory when finalizing the publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');

      await expect(
        publishDist(staged, dist, () => Promise.reject(new Error('sidecar failed')))
      ).rejects.toThrow('sidecar failed');

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('old');
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not roll back over a newer concurrent publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const stagedA = join(root, 'staged-a');
    const stagedB = join(root, 'staged-b');
    const dist = join(root, 'dist');
    let finalizeStarted!: () => void;
    let rejectFinalize!: (error: Error) => void;
    const finalizeStartedPromise = new Promise<void>((resolve) => {
      finalizeStarted = resolve;
    });
    const finalizePromise = new Promise<void>((_resolve, reject) => {
      rejectFinalize = reject;
    });
    try {
      await mkdir(stagedA);
      await mkdir(stagedB);
      await mkdir(dist);
      await writeFile(join(stagedA, 'index.html'), 'build A');
      await writeFile(join(stagedB, 'index.html'), 'build B');
      await writeFile(join(dist, 'index.html'), 'old');

      const publishA = publishDist(stagedA, dist, async () => {
        finalizeStarted();
        await finalizePromise;
      });
      await finalizeStartedPromise;

      await publishDist(stagedB, dist);
      rejectFinalize(new Error('build A finalizer failed'));
      await expect(publishA).rejects.toThrow('build A finalizer failed');

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('build B');
      removeTempPaths();
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );
    } finally {
      removeTempPaths();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not restore over a newer publication that is still mid-swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const stagedA = join(root, 'staged-a');
    const stagedB = join(root, 'staged-b');
    const dist = join(root, 'dist');
    const backupB = join(root, 'backup-b');
    try {
      await mkdir(stagedA);
      await mkdir(stagedB);
      await mkdir(dist);
      await writeFile(join(stagedA, 'index.html'), 'build A');
      await writeFile(join(stagedB, 'index.html'), 'build B');
      await writeFile(join(dist, 'index.html'), 'old');

      // Fail A at the one moment a newer transaction owns the publication but
      // has nothing at `dist` yet: after its `rename(dist, backup)` and before
      // its `rename(staged, dist)`. A cannot see whose bundle is missing.
      await expect(
        publishDist(stagedA, dist, async () => {
          await rename(dist, backupB);
          throw new Error('build A finalizer failed');
        })
      ).rejects.toThrow('build A finalizer failed');

      // The pre-A bundle must stay gone, here and through cleanup. Putting it
      // back is what fails the newer rename with ENOTEMPTY and leaves a stale
      // bundle live.
      expect(existsSync(dist)).toBe(false);
      removeTempPaths();
      expect(existsSync(dist)).toBe(false);
      expect((await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'))).toEqual(
        []
      );

      // So the newer transaction finishes as if this one had never run.
      await rename(stagedB, dist);
      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('build B');
    } finally {
      removeTempPaths();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps the backup when the rollback cannot remove the failed bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-publish-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');

      // The branch where `dist` exists but is *not* a successful publish: the
      // sidecar failed, and the rollback's own removal of the failed bundle
      // failed too. Cleanup must read this as "leave the backup alone", never
      // as "the backup is redundant" — it holds the only copy of the previous
      // bundle.
      const removal = new RefusingRemoval();
      const failure = await publishDist(
        staged,
        dist,
        () => Promise.reject(new Error('sidecar failed')),
        removal.remove
      ).catch((error: unknown) => error);

      if (!(failure instanceof AggregateError)) {
        throw new Error(
          `expected publishDist to reject with: AggregateError | received: ${failure}`
        );
      }
      if (removal.attempts.length !== 1) {
        throw new Error(
          `expected rollback removal attempts: 1 | received: ${JSON.stringify(removal.attempts)}`
        );
      }

      // What the CLI entrypoint does next on a failed build, with `dist` still
      // holding the failed bundle.
      removeTempPaths();

      const backups = (await readdir(root)).filter((entry) => entry.startsWith('.dist-backup-'));
      if (backups.length !== 1) {
        throw new Error(
          `expected .dist-backup-* directories after cleanup: 1 | received: ${backups.length}`
        );
      }
      const backup = join(root, backups[0] as string);
      expect(await readFile(join(backup, 'index.html'), 'utf8')).toBe('old');
      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('new');
      // The operator has to be told where the previous bundle is.
      expect(failure.message).toContain(backup);
    } finally {
      removeTempPaths();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The stamp the API's dev server reads back. Its shape is a contract across two
 * workspaces that cannot import each other's code, so it is pinned from both
 * ends: `apps/api/tests/unit/server/dev-frontend.test.ts` asserts the reader
 * accepts exactly these two fields, and this asserts the writer emits them.
 */
describe('writeBuildState', () => {
  test('writes both fields the freshness check compares', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-state-'));
    try {
      const tailwindInputs = createTailwindInputs(
        readSourceInventory(join(import.meta.dir, '../..')),
        [],
        []
      );
      await writeBuildState(root, {
        apiUrl: 'https://api.example.test',
        mode: 'production',
        tailwindInputs,
      });
      expect(JSON.parse(await readFile(join(root, BUILD_STATE_FILE), 'utf8'))).toEqual({
        apiUrl: 'https://api.example.test',
        mode: 'production',
        tailwindInputs,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Interrupt cleanup. `publishDist` moves the live bundle aside before renaming
 * the staged one into place, and Ctrl-C is how the dev server that spawns a
 * build on every boot is normally stopped. Killed in that window the process
 * used to leave `dist/` absent and a full bundle copy under a `.dist-backup-`
 * name nothing ever reaped.
 */
describe('removeTempPaths', () => {
  test('removes tracked directories and files, and forgets them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-temp-'));
    try {
      const directory = trackTempPath(join(root, '.dist-backup-abc'));
      const file = trackTempPath(join(root, '.dist-metafile-staging-abc'));
      await mkdir(directory);
      await writeFile(join(directory, 'index.html'), 'old');
      await writeFile(file, '{}');

      removeTempPaths();

      expect(existsSync(directory)).toBe(false);
      expect(existsSync(file)).toBe(false);

      // Forgotten, not just deleted: a path that stayed tracked would be removed
      // again by a later interrupt, after the name had been reused.
      await mkdir(directory);
      removeTempPaths();
      expect(existsSync(directory)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores the rollback backup when the replacement was never published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-temp-'));
    const staged = trackTempPath(join(root, '.dist-staging-abc'));
    const dist = join(root, 'dist');
    const backup = trackTempPath(join(root, '.dist-backup-abc'), { restoreTo: dist });
    try {
      await mkdir(staged);
      await writeFile(join(staged, 'index.html'), 'new');
      await mkdir(dist);
      await writeFile(join(dist, 'index.html'), 'old');

      // The state a failed publish leaves behind: the live bundle moved aside
      // and the replacement never landed. Reached from `publishDist`'s
      // `AggregateError` path, not from a signal — the renames there are
      // synchronous, so no handler can interleave between them. Cleanup has to
      // put the previous bundle back rather than delete it.
      await rename(dist, backup);
      removeTempPaths();

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('old');
      expect(existsSync(backup)).toBe(false);
      expect(existsSync(staged)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps the replacement once it is published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-temp-'));
    const staged = trackTempPath(join(root, '.dist-staging-abc'));
    const dist = join(root, 'dist');
    const backup = trackTempPath(join(root, '.dist-backup-abc'), { restoreTo: dist });
    try {
      await mkdir(staged);
      await writeFile(join(staged, 'index.html'), 'new');
      await mkdir(dist);
      await writeFile(join(dist, 'index.html'), 'old');

      // Interruptible for real: `publishDist` awaits `finalize()` here, so a
      // signal handler can observe this state.
      await rename(dist, backup);
      await rename(staged, dist);
      removeTempPaths();

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('new');
      expect(existsSync(backup)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leaves a published bundle alone after publishDist succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontend-temp-'));
    const staged = join(root, 'staged');
    const dist = join(root, 'dist');
    try {
      await mkdir(staged);
      await mkdir(dist);
      await writeFile(join(staged, 'index.html'), 'new');
      await writeFile(join(dist, 'index.html'), 'old');

      await publishDist(staged, dist);
      removeTempPaths();

      expect(await readFile(join(dist, 'index.html'), 'utf8')).toBe('new');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('compiler failure publication', () => {
  async function isolatedBuildFixture(): Promise<{ isolated: string; frontend: string }> {
    const repository = join(import.meta.dir, '../../../..');
    await mkdir(join(repository, '.mango'), { recursive: true });
    const isolated = await mkdtemp(join(repository, '.mango/tailwind-rollback-'));
    const frontend = join(isolated, 'apps/frontend');
    cpSync(join(repository, 'apps/frontend'), frontend, {
      recursive: true,
      filter: (path) =>
        !['node_modules', 'dist', 'dist-metafile.json', '.turbo', '.tanstack', 'tests'].includes(
          basename(path)
        ),
    });
    const modules = join(frontend, 'node_modules');
    await mkdir(modules);
    const installed = join(repository, 'apps/frontend/node_modules');
    for (const entry of await readdir(installed)) {
      if (entry.startsWith('.')) continue;
      if (!entry.startsWith('@')) {
        const source = realpathSync(join(installed, entry));
        if (entry === 'tailwindcss') cpSync(source, join(modules, entry), { recursive: true });
        else symlinkSync(source, join(modules, entry), 'junction');
        continue;
      }
      await mkdir(join(modules, entry));
      for (const child of await readdir(join(installed, entry))) {
        const source = realpathSync(join(installed, entry, child));
        if (entry === '@xterm' && child === 'xterm')
          cpSync(source, join(modules, entry, child), { recursive: true });
        else symlinkSync(source, join(modules, entry, child), 'junction');
      }
    }
    await mkdir(join(isolated, '.git'));
    await mkdir(join(isolated, 'apps/shared/src/frontend-build'), { recursive: true });
    cpSync(
      join(repository, 'apps/shared/src/frontend-build/host.ts'),
      join(isolated, 'apps/shared/src/frontend-build/host.ts')
    );
    cpSync(join(repository, 'bun.lock'), join(isolated, 'bun.lock'));
    await mkdir(join(frontend, 'dist'));
    await writeFile(join(frontend, 'dist/index.html'), 'previous published bundle');
    await writeFile(join(frontend, 'dist-metafile.json'), 'previous metafile');
    return { isolated, frontend };
  }

  async function assertPreviousOutput(frontend: string): Promise<void> {
    expect(await readFile(join(frontend, 'dist/index.html'), 'utf8')).toBe(
      'previous published bundle'
    );
    expect(await readFile(join(frontend, 'dist-metafile.json'), 'utf8')).toBe('previous metafile');
    expect((await readdir(frontend)).filter((name) => name.startsWith('.dist-'))).toEqual([]);
  }

  test('keeps the previous dist and metafile when stylesheet compilation fails', async () => {
    const { isolated, frontend } = await isolatedBuildFixture();
    try {
      await writeFile(
        join(frontend, 'src/index.css'),
        '@import "./missing-tailwind-stylesheet.css";'
      );
      const child = Bun.spawn([process.execPath, './build.ts', '--dev'], {
        cwd: frontend,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 1 });
      expect(stderr).toContain('expected resolvable Tailwind stylesheet');
      expect(stderr).toContain('missing-tailwind-stylesheet.css');
      await assertPreviousOutput(frontend);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  test('rejects a source mutation during final compilation and cleans staged output', async () => {
    const { isolated, frontend } = await isolatedBuildFixture();
    try {
      const preload = join(frontend, 'scripts/mutate-after-discovery.ts');
      await writeFile(
        preload,
        `
        import { mock } from 'bun:test';
        import { writeFileSync } from 'node:fs';
        import * as original from '@tailwindcss/node';
        const realCompile = original.compile;
        let entryCompiles = 0;
        async function fakeCompileMutatesSourceAfterDiscovery(source, options) {
          const result = await realCompile(source, options);
          if (options.from === ${JSON.stringify(join(frontend, 'src/index.css'))} && ++entryCompiles === 2) {
            writeFileSync(${JSON.stringify(join(frontend, 'src/capture-race.tsx'))}, 'export const utility = "z-[671234]";');
            console.error('compiler mutation applied after discovery');
          }
          return result;
        }
        function fakeTailwindModule() { return { ...original, compile: fakeCompileMutatesSourceAfterDiscovery }; }
        mock.module('@tailwindcss/node', fakeTailwindModule);
      `
      );
      const child = Bun.spawn([process.execPath, '--preload', preload, './build.ts', '--dev'], {
        cwd: frontend,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('compiler mutation applied after discovery');
      expect(stderr).toContain(
        'expected unchanged Tailwind inputs between dependency discovery and publication'
      );
      await assertPreviousOutput(frontend);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
