/**
 * Cancellation for a stdio launch — exercised against a fake handshake rather
 * than a real process. `spawn-runtime-child.integration.test.ts` covers the
 * real spawn, handshake, and teardown path; this file's fake handshake is a
 * gate a test controls by hand, which a real child's timing cannot give one.
 */

import { describe, expect, it } from 'bun:test';
import type { RemoteError } from '@mangostudio/protocol';
import type { SpawnOptions } from '@mangostudio/protocol/spawn';
import { HUB_WORKSPACE_AUTHORIZE_METHOD } from '@mangostudio/shared/runtime-contract';
import { getDb } from '../../../src/db/database';
import type { HubWorkspaceBinding } from '../../../src/services/runtime-client/hub-workspace-authority';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { DeferredSpawnPort } from '../../support/mocks/deferred-spawn-port';

describe('spawnRuntimeChild — cancellation', () => {
  it('keeps a failed handshake on the short stop budget', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();
    let launchOptions: SpawnOptions | undefined;

    const attempt = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
        signal: controller.signal,
      },
      {
        spawnPort: (options) => {
          launchOptions = options;
          return fake.spawnPort();
        },
      }
    );

    controller.abort();
    await attempt.catch(() => undefined);
    expect(launchOptions?.terminateGraceMs).toBe(2_000);
    expect(launchOptions?.killGraceMs).toBe(2_000);
    expect(launchOptions?.exitGraceMs).toBe(1_000);
    expect(fake.promotedTerminateGraceMs).toBeUndefined();
  });

  it('promotes a connected runtime to the 30-second total stop cap', async () => {
    const fake = new DeferredSpawnPort();
    const connectionPromise = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      },
      { spawnPort: fake.spawnPort }
    );
    fake.release();
    const connection = await connectionPromise;
    expect(fake.promotedTerminateGraceMs).toBe(27_000);
    await connection.close();
  });

  it('reaps the child when cancelled mid-handshake, before a late answer arrives', async () => {
    const fake = new DeferredSpawnPort();
    const controller = new AbortController();

    const attempt = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding: null,
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
        workspaceBinding: null,
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

describe('spawnRuntimeChild — workspace binding', () => {
  /** What the spawned runtime hears back when it asks the hub about `workdir`. */
  async function askThroughSpawn(
    workspaceBinding: HubWorkspaceBinding | null,
    workdir: string
  ): Promise<unknown> {
    const fake = new DeferredSpawnPort();
    const connecting = spawnRuntimeChild(
      {
        environmentId: 'devbox',
        launch: { command: 'fake-runtime', args: [] },
        workspaceBinding,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      },
      { spawnPort: fake.spawnPort }
    );
    const runtime = fake.release();
    if (!runtime) throw new Error('expected a runtime-side session | received: none');
    const connection = await connecting;
    try {
      return await runtime.request(HUB_WORKSPACE_AUTHORIZE_METHOD, {
        canonicalPath: workdir,
        purpose: 'external-agent',
      });
    } finally {
      await connection.close();
    }
  }

  it('answers for the binding the launcher passed, and nothing for none', async () => {
    const owner = await insertTestUser();
    const chat = await insertTestChat(owner.id);
    const workdir = '/home/owner/spawned-project';
    await getDb()
      .updateTable('chats')
      .set({ environmentId: 'devbox', workdir })
      .where('id', '=', chat.id)
      .execute();

    expect(await askThroughSpawn({ userId: owner.id, environmentId: 'devbox' }, workdir)).toEqual({
      authorized: true,
    });
    expect(await askThroughSpawn({ userId: owner.id, environmentId: 'other' }, workdir)).toEqual({
      authorized: false,
    });
    expect(await askThroughSpawn(null, workdir)).toEqual({ authorized: false });
  });
});
