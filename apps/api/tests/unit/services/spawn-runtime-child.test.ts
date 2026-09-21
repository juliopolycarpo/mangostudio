/**
 * Cancellation for a stdio launch — exercised against a fake handshake rather
 * than a real process. `spawn-runtime-child.integration.test.ts` covers the
 * real spawn, handshake, and teardown path; this file's fake handshake is a
 * gate a test controls by hand, which a real child's timing cannot give one.
 */

import { describe, expect, it } from 'bun:test';
import type { RemoteError } from '@mangostudio/protocol';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { DeferredSpawnPort } from '../../support/mocks/deferred-spawn-port';

describe('spawnRuntimeChild — cancellation', () => {
  it('reaps the child when cancelled mid-handshake, before a late answer arrives', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();

    const attempt = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        hubVersion: 'hub-test',
        handshakeTimeoutMs: 30_000,
        onClosed: () => undefined,
        signal: controller.signal,
      },
      { spawnPort: fake.spawnPort }
    );

    controller.abort();
    const error = (await attempt.catch((caught: unknown) => caught)) as RemoteError;

    expect(error.code).toBe('CANCELLED');
    expect(fake.terminateCallCount).toBe(1);

    // Late arrival: releasing after the rejection already settled must not
    // resurrect anything. Awaiting the rejection above — not a sleep — is
    // what makes "before" and "after" here deterministic.
    fake.release();
    expect(fake.terminateCallCount).toBe(1);
  });

  it('refuses to spawn at all when the signal is already aborted', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();
    controller.abort();

    const error = (await spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        hubVersion: 'hub-test',
        onClosed: () => undefined,
        signal: controller.signal,
      },
      { spawnPort: fake.spawnPort }
    ).catch((caught: unknown) => caught)) as RemoteError;

    expect(error.code).toBe('CANCELLED');
    expect(fake.spawnCallCount).toBe(0);
    expect(fake.terminateCallCount).toBe(0);
  });
});
