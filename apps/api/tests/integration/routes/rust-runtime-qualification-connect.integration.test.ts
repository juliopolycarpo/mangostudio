/**
 * Qualifies the third transport, paired connect, against the real, compiled
 * `crates/mangostudio-runtime` binary — never the TypeScript dialer
 * (`connectWebSocket` standing in for a runtime) that
 * `runtime-socket.integration.test.ts` uses to exercise the same accept
 * route.
 *
 * The binary is spawned as `mangostudio-runtime connect --hub <url> --token
 * env`, dialling into the hub's own real `/api/runtime` accept route
 * (`createRuntimeSocketRoutes`) with a real pairing token minted by the real
 * `createRuntimePairingService`/`createRuntimePairingRepository` — never a
 * hand-rolled token. `startHub` below is a trimmed copy of the identically
 * named helper in `runtime-socket.integration.test.ts`; it is not imported
 * from there because that file does not export it and this suite needs a
 * narrower slice (no upgrade-limit or gated-adopt test hooks).
 *
 * See `rust-runtime-qualification.integration.test.ts` for the stdio and
 * direct-URL-serve transports, and its own doc comment for the named
 * TS-to-Rust test inventory covering `runtime.health`, `workspace.*`, and
 * the typed `probing.*` request path. This file adds one further inventory
 * entry:
 *
 * | Pure-TS runtime assertion | Now also covered by |
 * | --- | --- |
 * | `apps/runtime/tests/unit/manifest.test.ts`'s handshake-manifest assertions, exercised here over a real hub-accepted WebSocket rather than an in-memory port pair | 'adopts a paired real runtime and answers runtime.health' |
 *
 * Paired connect has no TypeScript-runtime analogue for the redial/backoff
 * loop itself (`transport::connect::run_one_connection`'s own Rust unit
 * tests already cover that in isolation); this file only proves the hub's
 * real accept route completes a handshake with the compiled binary and can
 * route calls to it, which is the gap this whole task exists to close.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';
import { getDb } from '../../../src/db/database';
import { createRuntimePairingService } from '../../../src/modules/environments/application/runtime-pairing-service';
import { createRuntimeSocketRoutes } from '../../../src/modules/environments/http/runtime-socket-routes';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { createRuntimePairingRepository } from '../../../src/modules/environments/infrastructure/runtime-pairing-repository';
import { REALTIME_WEBSOCKET_OPTIONS } from '../../../src/modules/realtime/http/realtime-routes';
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestUser } from '../../support/factories';
import {
  assertRustRuntimeCommandMethods,
  assertRustRuntimeFeatureCeiling,
  assertRustRuntimeFilesystemMethods,
  assertRustRuntimeHealthShape,
  assertRustRuntimeLibraryMethods,
  assertRustRuntimeProbingMethods,
  assertRustRuntimeSnapshotMethods,
  assertRustRuntimeWorkspaceMethods,
} from '../../support/rust-runtime-assertions';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();

const TEST_USER = {
  id: 'rust-connect-qualification-user',
  name: 'Rust Connect Qualification User',
  email: 'rust-connect-qualification@mangostudio.test',
};

interface Hub {
  readonly manager: RuntimeConnectionManager;
  readonly environmentId: string;
  readonly url: string;
  readonly token: string;
  stop(): void;
  whenAdopted(count: number): Promise<void>;
}

/**
 * See this file's own doc comment for why this is a trimmed copy, not an
 * import. `environmentId` is unique per test (never a shared constant):
 * `RuntimeConnectionManager.getClient` resolves an environment by row, and
 * two tests racing the same id/user through the same in-memory test database
 * is a real hazard this suite does not need to take on to prove the
 * transport works.
 */
async function startHub(environmentId: string): Promise<Hub> {
  await insertTestUser(TEST_USER);
  const environments = createEnvironmentRepository(getDb());
  await environments.create({
    id: environmentId,
    userId: TEST_USER.id,
    name: 'Rust connect qualification',
    transportKind: 'websocket',
    config: {},
    enabled: true,
  });

  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId, environmentId) => environments.find(userId, environmentId),
    connectors: {},
  });
  const pairing = createRuntimePairingService({
    repository: createRuntimePairingRepository(getDb()),
    environments,
    manager,
    publish: () => undefined,
    publicUrl: () => 'https://hub.test',
  });
  const issued = await pairing.issue(TEST_USER.id, environmentId);

  let adoptions = 0;
  const counted = manager.adopt.bind(manager);
  manager.adopt = async (userId, environmentId, open) => {
    const client = await counted(userId, environmentId, open);
    adoptions += 1;
    return client;
  };

  const app = new Elysia()
    .use(websocket(REALTIME_WEBSOCKET_OPTIONS))
    .group('/api', (group) =>
      group.use(createRuntimeSocketRoutes({ pairing, manager, hubVersion: () => 'hub-test' }))
    );
  app.listen(0);
  const port = (app.server as { port?: number } | null)?.port;
  expect(port).toBeNumber();

  return {
    manager,
    environmentId,
    url: `ws://127.0.0.1:${port}/api/runtime`,
    token: issued.token,
    stop: () => {
      void app.server?.stop(true);
    },
    whenAdopted: (count: number) =>
      waitFor(() => adoptions >= count, `${count} adoption(s); the manager finished ${adoptions}`),
  };
}

/** Resolves once `predicate` holds, so a test never races the route's own turns. */
async function waitFor(predicate: () => boolean, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out; expected ${expected}.`);
}

describe('Real Rust runtime qualification: paired connect', () => {
  let hub: Hub | undefined;
  let mangoHome: string;
  let child: ReturnType<typeof Bun.spawn> | undefined;

  afterEach(async () => {
    if (child) {
      child.kill();
      await child.exited;
      child = undefined;
    }
    hub?.stop();
    hub = undefined;
    if (mangoHome) await cleanupMangoHome(mangoHome);
    await getDb().deleteFrom('runtime_pairing_tokens').where('userId', '=', TEST_USER.id).execute();
    await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
    await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
  });

  it.skipIf(!binary.available)(
    'adopts a paired real runtime and answers runtime.health',
    async () => {
      hub = await startHub('rust-connect-qualification-health');
      mangoHome = await scratchMangoHome('connect-health');

      child = Bun.spawn({
        cmd: [binary.path, 'connect', '--hub', hub.url, '--token', 'env'],
        env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_TOKEN: hub.token },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await hub.whenAdopted(1);
      const client = await hub.manager.getClient(TEST_USER.id, hub.environmentId);
      // `connect`, like `serve`, always answers as the `remote` slot.
      assertRustRuntimeHealthShape(await client.health(), { slot: 'remote' });
      assertRustRuntimeFeatureCeiling(client.manifest, {
        probing: true,
        fsRead: true,
        fsWrite: true,
        checkpoints: true,
        mcp: true,
      });
      await assertRustRuntimeProbingMethods(client);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'workspace, filesystem, snapshot and command methods round-trip over a paired real runtime connection',
    async () => {
      hub = await startHub('rust-connect-qualification-workspace');
      mangoHome = await scratchMangoHome('connect-workspace');

      child = Bun.spawn({
        cmd: [binary.path, 'connect', '--hub', hub.url, '--token', 'env'],
        env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_TOKEN: hub.token },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await hub.whenAdopted(1);
      const client = await hub.manager.getClient(TEST_USER.id, hub.environmentId);

      const dir = await realpath(await scratchMangoHome('connect-workspace-dir'));
      await assertRustRuntimeFilesystemMethods(client, dir);
      await assertRustRuntimeWorkspaceMethods(client, dir);
      await assertRustRuntimeSnapshotMethods(client, dir);
      await assertRustRuntimeCommandMethods(client, dir);
      await assertRustRuntimeLibraryMethods(client, dir);
      await cleanupMangoHome(dir);
    },
    30_000
  );
});
