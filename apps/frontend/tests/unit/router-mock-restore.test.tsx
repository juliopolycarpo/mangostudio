/**
 * `restoreRouter` is what keeps a route test's router fake from reaching the
 * files scheduled after it (#977). `mock.module()` is process-wide and
 * `mock.restore()` does not undo it, so without this a directory run depended
 * on `--isolate` for correctness.
 */

import { describe, expect, it, mock } from 'bun:test';

import { LinkStub, restoreRouter, routerWithLinkStub } from '../support/mocks/router';

const ROUTER = '@tanstack/react-router';

describe('restoreRouter', () => {
  it('replaces every export the fake overrode with the real one', async () => {
    // Function values, not the namespace: the namespace is live and would show the fake.
    const { Link: realLink, useNavigate: realUseNavigate } = await import(ROUTER);
    const fakeUseNavigate = () => 'fake navigate';

    await mock.module(ROUTER, await routerWithLinkStub({ useNavigate: fakeUseNavigate }));
    const faked = await import(ROUTER);
    expect(
      [faked.Link, faked.useNavigate],
      'expected the fake installed before the restore: [LinkStub, fakeUseNavigate]'
    ).toEqual([LinkStub, fakeUseNavigate]);

    await restoreRouter();

    const restored = await import(ROUTER);
    expect(
      [restored.Link === realLink, restored.useNavigate === realUseNavigate],
      'expected after restoreRouter: [real Link, real useNavigate] | received: a fake still installed'
    ).toEqual([true, true]);
  });
});
