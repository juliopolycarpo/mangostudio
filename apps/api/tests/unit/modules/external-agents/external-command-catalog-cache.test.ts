/**
 * The hub-process cache a reload's palette reads before this chat's own first
 * turn has announced a catalog of its own.
 */

import { describe, expect, it } from 'bun:test';
import type { ExternalCommandCatalogKey } from '../../../../src/modules/external-agents/application/external-command-catalog-cache';
import { createExternalCommandCatalogCache } from '../../../../src/modules/external-agents/application/external-command-catalog-cache';

const CLAUDE: ExternalCommandCatalogKey = {
  userId: 'user-1',
  environmentId: 'local',
  targetId: 'claude',
};

describe('external command catalog cache', () => {
  it('answers undefined for a key nothing has written', () => {
    const cache = createExternalCommandCatalogCache();
    expect(cache.read(CLAUDE)).toBeUndefined();
  });

  it('returns what was written for a matching key', () => {
    const cache = createExternalCommandCatalogCache();
    cache.write(CLAUDE, [{ name: 'review' }, { name: 'dataviz', description: 'Draws charts' }]);
    expect(cache.read(CLAUDE)).toEqual([
      { name: 'review' },
      { name: 'dataviz', description: 'Draws charts' },
    ]);
  });

  it('keeps entries separate per user, environment and target', () => {
    const cache = createExternalCommandCatalogCache();
    cache.write(CLAUDE, [{ name: 'review' }]);
    cache.write({ ...CLAUDE, userId: 'user-2' }, [{ name: 'other-user' }]);
    cache.write({ ...CLAUDE, environmentId: 'env-7' }, [{ name: 'other-env' }]);
    cache.write({ ...CLAUDE, targetId: 'cursor' }, [{ name: 'other-target' }]);

    expect(cache.read(CLAUDE)).toEqual([{ name: 'review' }]);
    expect(cache.read({ ...CLAUDE, userId: 'user-2' })).toEqual([{ name: 'other-user' }]);
    expect(cache.read({ ...CLAUDE, environmentId: 'env-7' })).toEqual([{ name: 'other-env' }]);
    expect(cache.read({ ...CLAUDE, targetId: 'cursor' })).toEqual([{ name: 'other-target' }]);
  });

  it('replaces, rather than accumulates, on a second write for the same key', () => {
    const cache = createExternalCommandCatalogCache();
    cache.write(CLAUDE, [{ name: 'first' }]);
    cache.write(CLAUDE, [{ name: 'second' }]);
    expect(cache.read(CLAUDE)).toEqual([{ name: 'second' }]);
  });

  /**
   * Bounded like the discovery cache, for the same reason: a hub with many
   * users and environments must not grow this without limit. The oldest
   * *unwritten* key is what a bound has to evict, not merely the oldest
   * inserted — otherwise a key several turns keep re-announcing would still
   * age out from under an otherwise-active chat.
   */
  it('evicts the least recently written entry once the bound is crossed', () => {
    const cache = createExternalCommandCatalogCache();
    const total = 1_001; // one past MAX_ENTRIES
    for (let index = 0; index < total; index += 1) {
      cache.write({ userId: `user-${index}`, environmentId: 'local', targetId: 'claude' }, [
        { name: `command-${index}` },
      ]);
    }

    expect(
      cache.read({ userId: 'user-0', environmentId: 'local', targetId: 'claude' })
    ).toBeUndefined();
    expect(cache.read({ userId: 'user-1000', environmentId: 'local', targetId: 'claude' })).toEqual(
      [{ name: 'command-1000' }]
    );
  });

  it('does not evict a key that was re-written more recently than the oldest one', () => {
    const cache = createExternalCommandCatalogCache();
    const total = 1_000; // exactly MAX_ENTRIES
    for (let index = 0; index < total; index += 1) {
      cache.write({ userId: `user-${index}`, environmentId: 'local', targetId: 'claude' }, [
        { name: `command-${index}` },
      ]);
    }
    // Touch the very first key again, so it is no longer the least recently written.
    cache.write({ userId: 'user-0', environmentId: 'local', targetId: 'claude' }, [
      { name: 'command-0-refreshed' },
    ]);
    // One more new key crosses the bound; the entry evicted should be the
    // *second* one written, since the first was just refreshed.
    cache.write({ userId: 'user-1000', environmentId: 'local', targetId: 'claude' }, [
      { name: 'command-1000' },
    ]);

    expect(cache.read({ userId: 'user-0', environmentId: 'local', targetId: 'claude' })).toEqual([
      { name: 'command-0-refreshed' },
    ]);
    expect(
      cache.read({ userId: 'user-1', environmentId: 'local', targetId: 'claude' })
    ).toBeUndefined();
  });
});
