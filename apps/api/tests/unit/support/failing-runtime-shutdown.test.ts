import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { createManagedProcessFixture } from '../../support/fixtures/managed-process';

it('awaits a cancelled warmup opener and its late close before injecting shutdown failure', async () => {
  const fixture = await createManagedProcessFixture({ tempPrefix: 'mango-shutdown-failure-' });
  try {
    fixture.spawn({
      cmd: [
        process.execPath,
        '--preload',
        fileURLToPath(new URL('../../support/fixtures/shutdown-trace-preload.ts', import.meta.url)),
        '--preload',
        fileURLToPath(
          new URL('../../support/fixtures/failing-runtime-shutdown.ts', import.meta.url)
        ),
        fileURLToPath(
          new URL('../../support/fixtures/pending-runtime-shutdown.ts', import.meta.url)
        ),
      ],
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
    fixture.spawn({
      cmd: [
        process.execPath,
        '--preload',
        fileURLToPath(new URL('../../support/fixtures/shutdown-trace-preload.ts', import.meta.url)),
        '--preload',
        fileURLToPath(
          new URL('../../support/fixtures/failing-runtime-shutdown.ts', import.meta.url)
        ),
        fileURLToPath(
          new URL('../../support/fixtures/pending-runtime-shutdown.ts', import.meta.url)
        ),
      ],
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
