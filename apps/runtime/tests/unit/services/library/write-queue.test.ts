import { describe, expect, it } from 'bun:test';
import { serializeRuntimeLibraryWrite } from '../../../../src/services/library/write-queue';

describe('serializeRuntimeLibraryWrite', () => {
  it('runs writes against one backup root one at a time', async () => {
    const order: string[] = [];
    const first = Promise.withResolvers<void>();

    const a = serializeRuntimeLibraryWrite('/backups', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = serializeRuntimeLibraryWrite('/backups', () => {
      order.push('b:start');
      return Promise.resolve();
    });

    // This is the window the hub cannot close: once its deadline fires it has
    // released its own lock and would start `b`, so `b` must not touch the tree
    // until `a` has finished compensating.
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('does not make one root wait on another', async () => {
    const blocked = Promise.withResolvers<void>();
    const held = serializeRuntimeLibraryWrite('/one', () => blocked.promise);
    await expect(serializeRuntimeLibraryWrite('/two', () => Promise.resolve('ran'))).resolves.toBe(
      'ran'
    );
    blocked.resolve();
    await held;
  });

  it('lets the next write run after the previous one rejects', async () => {
    const failing = serializeRuntimeLibraryWrite('/backups', () =>
      Promise.reject(new Error('disk full'))
    );
    await expect(failing).rejects.toThrow('disk full');
    await expect(
      serializeRuntimeLibraryWrite('/backups', () => Promise.resolve('next'))
    ).resolves.toBe('next');
  });
});
