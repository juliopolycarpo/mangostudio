import { expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundleShutdownFixture } from '../../support/fixtures/bundle-shutdown-fixture';
import { createManagedProcessFixture } from '../../support/fixtures/managed-process';

it('awaits a cancelled warmup opener and its late close before injecting shutdown failure', async () => {
  const fixture = await createManagedProcessFixture({ tempPrefix: 'mango-shutdown-failure-' });
  try {
    const entry = await bundleShutdownFixture(
      fileURLToPath(new URL('../../support/fixtures/pending-shutdown-entry.ts', import.meta.url)),
      fixture.tempDir
    );
    fixture.spawn({
      cmd: [process.execPath, entry],
      env: {
        ...process.env,
        HOME: fixture.tempDir,
        USERPROFILE: fixture.tempDir,
        MANGO_SHUTDOWN_TRACE: '1',
        MANGO_SHUTDOWN_STALL: undefined,
      },
    });
    const exitCode = await fixture.waitForExit();
    if (exitCode !== 0) {
      throw new Error(
        `Expected pending runtime shutdown proof to exit 0.\n${fixture.diagnostics()}`
      );
    }
    expect(fixture.diagnostics()).toMatch(
      /preload-admitted \d+ms\npreload-import-finished \d+ms\nfixture-started \d+ms\nopener-started \d+ms\nopener-cancelled \d+ms\nclose-started \d+ms\nshutdown-rejected \d+ms/
    );
    expect(fixture.diagnostics()).toContain(
      '"events":["open-started","open-cancelled","close-started","close-finished","shutdown-rejected"]'
    );
  } finally {
    await fixture.cleanup();
    await fixture.assertReleased();
  }
});

it('reports the last reached stage when the shutdown fixture stalls', async () => {
  const fixture = await createManagedProcessFixture({ tempPrefix: 'mango-shutdown-stalled-' });
  try {
    const entry = await bundleShutdownFixture(
      fileURLToPath(new URL('../../support/fixtures/pending-shutdown-entry.ts', import.meta.url)),
      fixture.tempDir
    );
    fixture.spawn({
      cmd: [process.execPath, entry],
      env: {
        ...process.env,
        HOME: fixture.tempDir,
        USERPROFILE: fixture.tempDir,
        MANGO_SHUTDOWN_TRACE: '1',
        MANGO_SHUTDOWN_STALL: 'opener-started',
      },
    });
    await fixture.waitUntilReady(() => fixture.diagnostics().includes('opener-started'), {
      label: 'shutdown fixture opener',
      timeoutMs: 5000,
    });
    await expect(fixture.waitForExit(50)).rejects.toThrow(
      /Child process did not exit within 50ms\.[\s\S]*opener-started/
    );
    expect(fixture.diagnostics()).not.toContain('opener-cancelled');
  } finally {
    await fixture.cleanup();
    await fixture.assertReleased();
  }
});

it('preserves source metadata and runs the bundled entry once', async () => {
  const fixture = await createManagedProcessFixture({ tempPrefix: 'mango-shutdown-bundle-' });
  try {
    const firstSource = join(fixture.tempDir, 'first');
    const first = join(fixture.tempDir, 'first-alias');
    const second = join(fixture.tempDir, 'second');
    await Promise.all([mkdir(firstSource), mkdir(second)]);
    await symlink(firstSource, first, process.platform === 'win32' ? 'junction' : 'dir');
    const moduleA = join(first, 'module.ts');
    const moduleB = join(second, 'module.ts');
    const entry = join(first, 'entry.ts');
    await Promise.all([
      Bun.write(
        moduleA,
        'export const metadata = [import.meta.dir, import.meta.url, import.meta.main];'
      ),
      Bun.write(
        moduleB,
        'export const metadata = [import.meta.dir, import.meta.url, import.meta.main];'
      ),
      Bun.write(
        entry,
        `import { metadata as a } from './module';
import { metadata as b } from '../second/module';
console.log(JSON.stringify([a, b]));`
      ),
    ]);
    const bundled = await bundleShutdownFixture(entry, join(fixture.tempDir, 'output'));
    fixture.spawn({ cmd: [process.execPath, bundled] });
    expect(await fixture.waitForExit()).toBe(0);
    expect(fixture.diagnostics()).toContain(
      JSON.stringify([
        [realpathSync.native(first), pathToFileURL(realpathSync.native(moduleA)).href, false],
        [realpathSync.native(second), pathToFileURL(realpathSync.native(moduleB)).href, false],
      ])
    );
    expect(fixture.diagnostics().match(/stdout:/g)).toHaveLength(1);
    expect(fixture.diagnostics().match(/\[\[/g)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
    await fixture.assertReleased();
  }
});
