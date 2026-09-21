/**
 * Qualifies two of the three ways a runtime reaches a hub against the real,
 * compiled `crates/mangostudio-runtime` binary — never the TypeScript
 * in-process runtime every other integration test in this repository spawns
 * or dials instead:
 *
 * - **stdio**: the hub spawns the binary as a child, exactly the way
 *   `resolveRuntimeLaunchCommand`'s `MANGOSTUDIO_RUNTIME_BINARY` override
 *   selects it in production, and speaks to it through the real
 *   `spawnRuntimeChild` + `RuntimeClient`.
 * - **direct URL ("serve")**: the binary is spawned as `mangostudio-runtime
 *   serve --listen <addr> --token env`, and the hub dials it with the real
 *   `connectHttpRuntime`, `RuntimeConnectionManager`, and
 *   `createEnvironmentService` — the identical path
 *   `connect-http-runtime.integration.test.ts` exercises against the
 *   TypeScript runtime's own `serveRuntime`.
 *
 * The third transport, paired connect (the binary dialling into the hub),
 * is qualified separately in
 * `apps/api/tests/integration/routes/rust-runtime-qualification-connect.integration.test.ts`,
 * since it needs the hub's real accept route rather than a service-level
 * connector.
 *
 * ## Named TS-to-Rust test inventory
 *
 * `crates/mangostudio-runtime/src/health.rs`'s own module doc names what this
 * crate deliberately does not build yet (`gh`, `terminal`, `externalAgents`,
 * `platformId`, `auditError` — all optional on the wire). The pure-TypeScript
 * runtime assertions below are now also proven end-to-end against the real
 * Rust binary, through the real hub call path, by the named test in this
 * file (or its `-connect` sibling):
 *
 * | Pure-TS runtime assertion | Now also covered by |
 * | --- | --- |
 * | `apps/runtime/tests/unit/cli.test.ts` "serves a handshake and a request over its pipes, then exits on EOF" (asserts `hello.capabilities.pathStyle` and `runtime.health.runtimeVersion` over a real stdio child) | this file's "stdio" describe block, every test |
 * | `apps/runtime/tests/unit/manifest.test.ts` "derives a full profile from the full allow set" | "reports the shape runtime.health promises, over stdio" / "…over a direct URL serve connection" (asserts `allow`/`profile` for a freshly auto-granted slot) |
 * | `apps/runtime/tests/unit/services/workspace-browse.test.ts` "returns directories only, sorted case-insensitively, with hidden metadata" | "workspace methods round-trip over stdio" / "…over a direct URL serve connection" (browse success case) |
 * | `apps/runtime/tests/unit/services/workspace-browse.test.ts` "maps missing paths without exposing raw filesystem messages" | same tests (browse error case) |
 * | `apps/runtime/tests/unit/services/workdir-validation.test.ts` "returns the resolved path for an existing directory" | same tests (validate success case) |
 * | `apps/runtime/tests/unit/services/workdir-validation.test.ts` "distinguishes missing paths from regular files" | same tests (validate `{ ok: false }` case) |
 * | `apps/runtime/tests/unit/services/workdir-validation.test.ts` "rejects empty paths with WorkspacePathError" | same tests (validate thrown-error case) |
 * | `apps/runtime/tests/unit/services/workspace-resolve-contained.test.ts` "returns the root-relative path for a file inside the root" | same tests (resolve-contained success case) |
 * | `apps/runtime/tests/unit/services/workspace-resolve-contained.test.ts` "rejects the root itself, which is not a path within the root" (an escape) | same tests (resolve-contained error case) |
 * | `apps/runtime/tests/unit/services/probing/toolchains.test.ts` typed `probing.*` request/result handling | the health tests over stdio and direct URL, through `assertRustRuntimeProbingMethods` |
 *
 * **Not yet replaced** — no Rust equivalent exists, per `health.rs`'s own
 * module doc: any TS assertion covering `gh`, `terminal`, or `externalAgents`
 * health fields (e.g. `apps/runtime/tests/unit/manifest.test.ts` "announces
 * gh under the same consent as git"), and the paired-connect transport's own
 * inventory entries live in the `-connect` sibling file instead.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { getDb } from '../../../src/db/database';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../../src/services/runtime-client/runtime-token-secrets';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { insertTestUser } from '../../support/factories';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';
import {
  assertRustRuntimeFeatureCeiling,
  assertRustRuntimeFilesystemMethods,
  assertRustRuntimeHealthShape,
  assertRustRuntimeProbingMethods,
  assertRustRuntimeWorkspaceMethods,
} from '../../support/rust-runtime-assertions';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();

async function setRustRuntimeProfile(mangoHome: string, profile: 'full' | 'none'): Promise<void> {
  const setup = Bun.spawn({
    cmd: [binary.path, 'setup', '--slot', 'remote', '--profile', profile],
    env: { ...process.env, MANGO_HOME: mangoHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    setup.exited,
    new Response(setup.stdout).text(),
    new Response(setup.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(`Configured the remote runtime as ${profile}.`);
  expect(stderr).toBe('');
}

describe('Real Rust runtime qualification', () => {
  let runtimeVersion: string;

  beforeAll(async () => {
    if (!binary.available) return;
    runtimeVersion = await rustRuntimeVersion(binary.path);
  });

  describe('stdio', () => {
    let mangoHome: string;
    let previousMangoHome: string | undefined;

    afterEach(async () => {
      if (previousMangoHome === undefined) delete process.env.MANGO_HOME;
      else process.env.MANGO_HOME = previousMangoHome;
      if (mangoHome) await cleanupMangoHome(mangoHome);
    });

    it.skipIf(!binary.available)(
      'reports the shape runtime.health promises, over stdio',
      async () => {
        mangoHome = await scratchMangoHome('stdio-health');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;

        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-qualification',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        try {
          const client = new RuntimeClient(connection.hub, () => undefined, 'rust-stdio');
          // A `target/debug` binary resolves the `host` slot for a stdio
          // launch: `resolve_runtime_slot_for_current_exe` never places it
          // inside any slot's managed install layout.
          assertRustRuntimeHealthShape(await client.health(), { slot: 'host' });
          await assertRustRuntimeProbingMethods(client);
        } finally {
          await connection.close();
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'workspace methods round-trip over stdio',
      async () => {
        mangoHome = await scratchMangoHome('stdio-workspace');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;

        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-qualification',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        try {
          const client = new RuntimeClient(connection.hub, () => undefined, 'rust-stdio');
          const dir = await realpath(await scratchMangoHome('stdio-workspace-dir'));
          await assertRustRuntimeWorkspaceMethods(client, dir);
          await cleanupMangoHome(dir);
        } finally {
          await connection.close();
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'filesystem methods round-trip over stdio',
      async () => {
        mangoHome = await scratchMangoHome('stdio-filesystem');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;
        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-filesystem',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        const directory = await realpath(await scratchMangoHome('stdio-filesystem-dir'));
        try {
          const client = new RuntimeClient(
            connection.hub,
            () => undefined,
            'rust-stdio-filesystem'
          );
          assertRustRuntimeFeatureCeiling(client.manifest, {
            probing: true,
            fsRead: true,
            fsWrite: true,
          });
          await assertRustRuntimeFilesystemMethods(client, directory);
        } finally {
          await connection.close();
          await cleanupMangoHome(directory);
        }
      },
      30_000
    );
  });

  describe('direct URL serve', () => {
    const TEST_USER = {
      id: 'rust-serve-qualification-user',
      name: 'Rust Serve Qualification User',
      email: 'rust-serve-qualification@mangostudio.test',
    };

    let mangoHome: string;
    let child: ReturnType<typeof Bun.spawn> | undefined;

    afterEach(async () => {
      if (child) {
        child.kill();
        await child.exited;
        child = undefined;
      }
      setRuntimeConnectionManagerForTests(undefined);
      setRuntimeTokenStoreForTests(undefined);
      if (mangoHome) await cleanupMangoHome(mangoHome);
      await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
      await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
    });

    it.skipIf(!binary.available)(
      'reports the shape runtime.health promises, over a direct URL serve connection',
      async () => {
        await insertTestUser(TEST_USER);
        const store = new InMemorySecretStore();
        setRuntimeTokenStoreForTests(store);
        const token = 'rust-serve-qualification-token';
        mangoHome = await scratchMangoHome('serve-health');
        const port = reserveEphemeralPort();

        child = Bun.spawn({
          cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
          env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token },
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const repository = createEnvironmentRepository(getDb());
        const manager = new RuntimeConnectionManager({
          resolveEnvironment: async (userId, environmentId) =>
            repository.find(userId, environmentId),
          connectors: { http: connectHttpRuntime },
        });
        setRuntimeConnectionManagerForTests(manager);
        const service = createEnvironmentService(repository, manager, () => undefined, store);

        await service.create(TEST_USER.id, {
          id: 'rust-serve-box',
          name: 'Rust serve box',
          transportKind: 'http',
          config: { baseUrl: `http://127.0.0.1:${port}` },
          token,
        });
        const connected = await connectUntilListening(() =>
          service.connect(TEST_USER.id, 'rust-serve-box')
        );
        expect(connected.status.state).toBe('connected');

        const client = await manager.getClient(TEST_USER.id, 'rust-serve-box');
        // `serve`/`connect` both always answer as the `remote` slot.
        assertRustRuntimeHealthShape(await client.health(), { slot: 'remote' });
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: true,
          fsRead: true,
          fsWrite: true,
        });
        await assertRustRuntimeProbingMethods(client);
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'preserves the implementation ceiling across repeated consent changes',
      async () => {
        await insertTestUser(TEST_USER);
        const store = new InMemorySecretStore();
        setRuntimeTokenStoreForTests(store);
        const token = 'rust-serve-qualification-refresh-token';
        mangoHome = await scratchMangoHome('serve-refresh');
        const port = reserveEphemeralPort();

        child = Bun.spawn({
          cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
          env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token },
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const repository = createEnvironmentRepository(getDb());
        const manager = new RuntimeConnectionManager({
          resolveEnvironment: async (userId, environmentId) =>
            repository.find(userId, environmentId),
          connectors: { http: connectHttpRuntime },
        });
        setRuntimeConnectionManagerForTests(manager);
        const service = createEnvironmentService(repository, manager, () => undefined, store);

        await service.create(TEST_USER.id, {
          id: 'rust-serve-refresh-box',
          name: 'Rust serve refresh box',
          transportKind: 'http',
          config: { baseUrl: `http://127.0.0.1:${port}` },
          token,
        });
        await connectUntilListening(() => service.connect(TEST_USER.id, 'rust-serve-refresh-box'));

        const client = await manager.getClient(TEST_USER.id, 'rust-serve-refresh-box');
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: true,
          fsRead: true,
          fsWrite: true,
        });
        const refreshed = await manager.refreshManifest(TEST_USER.id, 'rust-serve-refresh-box');
        expect(refreshed.state).toBe('connected');
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: true,
          fsRead: true,
          fsWrite: true,
        });

        await setRustRuntimeProfile(mangoHome, 'none');

        const revoked = await manager.refreshManifest(TEST_USER.id, 'rust-serve-refresh-box');
        expect(revoked.manifest?.allow).toEqual(RUNTIME_CONSENT_PRESETS.none);
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: false,
          fsRead: false,
          fsWrite: false,
        });

        await setRustRuntimeProfile(mangoHome, 'full');
        const restored = await manager.refreshManifest(TEST_USER.id, 'rust-serve-refresh-box');
        expect(restored.manifest?.allow).toEqual(RUNTIME_CONSENT_PRESETS.full);
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: true,
          fsRead: true,
          fsWrite: true,
        });
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'workspace methods round-trip over a direct URL serve connection',
      async () => {
        await insertTestUser(TEST_USER);
        const store = new InMemorySecretStore();
        setRuntimeTokenStoreForTests(store);
        const token = 'rust-serve-qualification-workspace-token';
        mangoHome = await scratchMangoHome('serve-workspace');
        const port = reserveEphemeralPort();

        child = Bun.spawn({
          cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
          env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token },
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const repository = createEnvironmentRepository(getDb());
        const manager = new RuntimeConnectionManager({
          resolveEnvironment: async (userId, environmentId) =>
            repository.find(userId, environmentId),
          connectors: { http: connectHttpRuntime },
        });
        setRuntimeConnectionManagerForTests(manager);
        const service = createEnvironmentService(repository, manager, () => undefined, store);

        await service.create(TEST_USER.id, {
          id: 'rust-serve-workspace-box',
          name: 'Rust serve workspace box',
          transportKind: 'http',
          config: { baseUrl: `http://127.0.0.1:${port}` },
          token,
        });
        await connectUntilListening(() =>
          service.connect(TEST_USER.id, 'rust-serve-workspace-box')
        );
        const client = await manager.getClient(TEST_USER.id, 'rust-serve-workspace-box');

        const dir = await realpath(await scratchMangoHome('serve-workspace-dir'));
        await assertRustRuntimeWorkspaceMethods(client, dir);
        await cleanupMangoHome(dir);
      },
      30_000
    );
  });
});

/** An unused TCP port on loopback, released back to the OS before returning. */
function reserveEphemeralPort(): number {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    // Never actually dialed; only the port number this reserves is used.
    socket: {
      open() {
        /* unused */
      },
      data() {
        /* unused */
      },
      close() {
        /* unused */
      },
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

/**
 * Retries `attempt` (a `service.connect(...)` call) until it succeeds, or
 * rethrows once `timeoutMs` has elapsed — `mangostudio-runtime serve` logs
 * nothing on a successful bind, and the hub's own `connect` already clears
 * any backoff on every call, so retrying the real production call is both
 * the readiness check and the assertion, rather than a separate bare-TCP
 * probe.
 *
 * A bare TCP connect-then-immediately-close was tried here first and
 * measured to leave the freshly spawned binary refusing every WebSocket
 * upgrade for several seconds afterwards, even though `ss` shows it bound
 * and listening throughout — a real interaction with the connection this
 * probe leaves half-open, not a fixed delay to paper over. Retrying the
 * real dial avoids ever opening that kind of connection at all.
 */
async function connectUntilListening<T>(attempt: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}
