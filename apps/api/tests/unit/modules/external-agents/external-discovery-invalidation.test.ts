import { describe, expect, it } from 'bun:test';

import { createDiscoveryInvalidation } from '../../../../src/modules/external-agents/application/external-discovery-invalidation';

describe('createDiscoveryInvalidation', () => {
  it('drops the environment cache of the owner, then tells the owner to refetch', () => {
    const calls: unknown[] = [];
    const invalidate = createDiscoveryInvalidation(
      { resetCache: (environmentId, userId) => calls.push(['reset', environmentId, userId]) },
      (userId) => calls.push(['publish', userId])
    );

    invalidate({ userId: 'user-1', environmentId: 'env-1', targetId: 'cursor' });

    expect(calls).toEqual([
      ['reset', 'env-1', 'user-1'],
      ['publish', 'user-1'],
    ]);
  });
});
