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
        fileURLToPath(
          new URL('../../support/fixtures/failing-runtime-shutdown.ts', import.meta.url)
        ),
        fileURLToPath(
          new URL('../../support/fixtures/pending-runtime-shutdown.ts', import.meta.url)
        ),
      ],
      env: { ...process.env, HOME: fixture.tempDir, USERPROFILE: fixture.tempDir },
    });
    const exitCode = await fixture.waitForExit();
    if (exitCode !== 0) {
      throw new Error(
        `Expected pending runtime shutdown proof to exit 0.\n${fixture.diagnostics()}`
      );
    }
    expect(fixture.diagnostics()).toContain(
      '"events":["open-started","open-cancelled","close-started","close-finished","shutdown-rejected"]'
    );
  } finally {
    await fixture.cleanup();
    await fixture.assertReleased();
  }
});
