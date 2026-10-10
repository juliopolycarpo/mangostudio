import { describe, expect, it } from 'bun:test';
import { createManagedProcessFixture } from '../../support/fixtures/managed-process';

describe('createManagedProcessFixture', () => {
  it('counts a child ended by a signal as released', async () => {
    const fixture = await createManagedProcessFixture({ tempPrefix: 'mango-managed-process-' });
    fixture.spawn({
      cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      env: process.env as Record<string, string>,
    });

    await fixture.stop('SIGKILL');
    await fixture.cleanup();

    // A signalled child reports no exit code; that alone must not read as still running.
    await expect(fixture.assertReleased()).resolves.toBeUndefined();
  });
});
