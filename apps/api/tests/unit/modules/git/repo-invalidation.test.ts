import { afterEach, describe, expect, it } from 'bun:test';

import type { RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';

import { publishRepoInvalidation } from '../../../../src/modules/git/application/repo-invalidation';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../../src/services/realtime/realtime-bus';

const TARGET = { userId: 'user-1', environmentId: 'local', workdir: '/repo/packages/api' } as const;

afterEach(() => {
  setRealtimeBusForTests(undefined);
});

/** One user's listeners on a real bus, so delivery is judged by who is subscribed. */
function listen(
  bus: ReturnType<typeof createRealtimeBus>,
  userId: string
): RealtimeInvalidateEvent[] {
  const received: RealtimeInvalidateEvent[] = [];
  bus.subscribe(userId, (event) => received.push(event));
  return received;
}

describe('publishRepoInvalidation', () => {
  it('publishes the repo topic with the given scopes to the writing user only', async () => {
    const bus = createRealtimeBus();
    setRealtimeBusForTests(bus);
    const owner = listen(bus, 'user-1');
    const ownerSecondTab = listen(bus, 'user-1');
    const stranger = listen(bus, 'user-2');

    await publishRepoInvalidation(TARGET, ['state', 'github'], {
      resolveRepoKeyForTarget: () => Promise.resolve('repoKeyAbc'),
    });

    const expected: RealtimeInvalidateEvent = {
      type: 'invalidate',
      topic: 'repo:repoKeyAbc',
      scopes: ['state', 'github'],
    };
    expect(owner).toEqual([expected]);
    expect(ownerSecondTab).toEqual([expected]);
    expect(stranger).toEqual([]);
  });

  it('publishes nothing when the repository has no key', async () => {
    const bus = createRealtimeBus();
    setRealtimeBusForTests(bus);
    const owner = listen(bus, 'user-1');

    await publishRepoInvalidation(TARGET, ['state'], {
      resolveRepoKeyForTarget: () => Promise.resolve(undefined),
    });

    expect(owner).toEqual([]);
  });

  it('resolves rather than rejects when the lookup fails, because the write already happened', async () => {
    const bus = createRealtimeBus();
    setRealtimeBusForTests(bus);
    const owner = listen(bus, 'user-1');

    await expect(
      publishRepoInvalidation(TARGET, ['state'], {
        resolveRepoKeyForTarget: () => Promise.reject(new Error('runtime offline')),
      })
    ).resolves.toBeUndefined();

    expect(owner).toEqual([]);
  });
});
