/**
 * Local through the real, compiled `mangostudio-runtime` binary: the connector
 * production registers for the Local environment, its binary resolution, and
 * the hub-side guarantees that used to rest on an in-process runtime — the
 * `host` slot's consent, the single-owner credential claim, workspace
 * authorization through the hub, terminal revocation, and reaping the child on
 * disconnect.
 *
 * The binary is `MANGOSTUDIO_RUNTIME_BINARY` in CI, or this checkout's newest
 * cargo build (`cargo build -p mangostudio-runtime`). Each test runs against a
 * scratch `MANGO_HOME`, which the spawned child inherits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_ENVIRONMENT_ID, LOCAL_ENVIRONMENT_NAME } from '@mangostudio/shared/environments';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  createLocalRuntimeConnector,
  RuntimeConnectionManager,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestUser } from '../../support/factories';
import {
  assertRustRuntimeCommandMethods,
  assertRustRuntimeFilesystemMethods,
  assertRustRuntimeHealthShape,
} from '../../support/rust-runtime-assertions';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import { processGone } from '../../support/rust-runtime-install-fixture';

const binary = resolveRustRuntimeBinary();
const isPosix = process.platform !== 'win32';

/** The TypeScript runtime's CLI, which wrote every runtime home before the Rust one. */
const TS_RUNTIME_CLI = join(import.meta.dir, '../../../../runtime/src/cli.ts');

/** A manager wired exactly as production wires Local: the real connector, no `open` override. */
function localManager(): RuntimeConnectionManager {
  return new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: LOCAL_ENVIRONMENT_NAME,
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: { 'in-process': createLocalRuntimeConnector() },
  });
}

/**
 * The pid of the runtime serving `client`, asked of the runtime itself: a shell
 * command's parent is the runtime's post-fork guardian, whose parent is the
 * runtime.
 */
async function runtimePid(
  client: Awaited<ReturnType<RuntimeConnectionManager['getClient']>>,
  cwd: string
): Promise<number> {
  const result = await client.shell.run({
    kind: 'bash',
    command: 'ps -o ppid= -p "$PPID"',
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  const pid = Number(result.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`expected the runtime's pid | received: ${JSON.stringify(result.stdout)}`);
  }
  return pid;
}

async function setHostProfile(mangoHome: string, profile: 'full' | 'none'): Promise<void> {
  const setup = Bun.spawn({
    cmd: [binary.path, 'setup', '--slot', 'host', '--profile', profile],
    env: { ...process.env, MANGO_HOME: mangoHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([setup.exited, new Response(setup.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(`expected setup to exit 0 | received: ${exitCode} (${stderr.trim()})`);
  }
}

describe('Local over the real Rust runtime', () => {
  let mangoHome = '';
  let previousMangoHome: string | undefined;
  let manager: RuntimeConnectionManager | undefined;

  beforeEach(async () => {
    mangoHome = await realpath(await scratchMangoHome('local'));
    previousMangoHome = process.env.MANGO_HOME;
    process.env.MANGO_HOME = mangoHome;
  });

  afterEach(async () => {
    await manager?.closeAll();
    manager = undefined;
    if (previousMangoHome === undefined) delete process.env.MANGO_HOME;
    else process.env.MANGO_HOME = previousMangoHome;
    await cleanupMangoHome(mangoHome);
  });

  it.skipIf(!binary.available)(
    'connects as the host slot and serves filesystem, shell and git methods',
    async () => {
      const user = await insertTestUser();
      manager = localManager();
      const client = await manager.getClient(user.id, LOCAL_ENVIRONMENT_ID);
      const scratch = join(mangoHome, 'work');
      await mkdir(scratch);

      // A cargo build sits in `target/`, outside every slot's install layout,
      // so it answers to the `host` slot's consent — what Local always did.
      assertRustRuntimeHealthShape(await client.health(), { slot: 'host' });
      await assertRustRuntimeFilesystemMethods(client, scratch);
      await assertRustRuntimeCommandMethods(client, scratch);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'attests one owner, withdraws it for a second, and never attests the stand-in',
    async () => {
      const [first, second] = await Promise.all([insertTestUser(), insertTestUser()]);
      manager = localManager();

      await manager.getClient('local', LOCAL_ENVIRONMENT_ID);
      expect(manager.isIdentityAttested('local', LOCAL_ENVIRONMENT_ID)).toBe(false);

      const firstClient = await manager.getClient(first.id, LOCAL_ENVIRONMENT_ID);
      // The runtime computes its own attestation from its home; the hub only
      // says whether it still stands behind a single owner.
      expect(firstClient.manifest.identityIsolation).toMatchObject({ method: 'os-account' });
      expect(manager.isIdentityAttested(first.id, LOCAL_ENVIRONMENT_ID)).toBe(true);
      // The per-call surface too, so its absence below is the withdrawal and
      // not a runtime that never reports one.
      expect((await firstClient.health()).externalAgents?.identityIsolation).toMatchObject({
        method: 'os-account',
      });

      const secondClient = await manager.getClient(second.id, LOCAL_ENVIRONMENT_ID);
      expect(secondClient.manifest.identityIsolation).toBeUndefined();
      expect((await secondClient.health()).externalAgents?.identityIsolation).toBeUndefined();
      expect({
        first: manager.isIdentityAttested(first.id, LOCAL_ENVIRONMENT_ID),
        second: manager.isIdentityAttested(second.id, LOCAL_ENVIRONMENT_ID),
      }).toEqual({ first: false, second: false });
      // The first owner's attested connection was closed, not left attested.
      expect(manager.getStatus(first.id, LOCAL_ENVIRONMENT_ID).state).not.toBe('connected');
    },
    30_000
  );

  it.skipIf(!binary.available || !isPosix)(
    'closes an attached terminal when the host slot revokes consent',
    async () => {
      const user = await insertTestUser();
      manager = localManager();
      const client = await manager.getClient(user.id, LOCAL_ENVIRONMENT_ID);
      const sessionId = 'local-pty-revocation';
      await client.terminal.open({ sessionId, shell: 'bash', cwd: mangoHome, cols: 80, rows: 24 });
      const exited = Promise.withResolvers<{ reason?: string }>();
      const unsubscribe = client.terminal.onOutput(sessionId, (event) => {
        if (event.kind === 'exit') exited.resolve(event);
      });
      try {
        await client.terminal.attach({ sessionId });
        await setHostProfile(mangoHome, 'none');
        const timeout = setTimeout(
          () => exited.reject(new Error('expected a consent-revoked exit | received: none in 10s')),
          10_000
        );
        const event = await exited.promise.finally(() => clearTimeout(timeout));
        expect(event.reason).toBe('consent-revoked');
        expect(await client.terminal.close({ sessionId })).toEqual({ ok: true });
      } finally {
        unsubscribe();
      }
    },
    30_000
  );

  it.skipIf(!binary.available || !isPosix)(
    'reaps the runtime child when Local disconnects',
    async () => {
      const user = await insertTestUser();
      manager = localManager();
      const client = await manager.getClient(user.id, LOCAL_ENVIRONMENT_ID);
      const pid = await runtimePid(client, mangoHome);
      expect(await processGone(pid, 0)).toBe(false);

      // `closeAll` resolves once the child has exited, not merely been asked to.
      await manager.closeAll();
      expect(await processGone(pid, 0)).toBe(true);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'serves a home the TypeScript runtime wrote without asking for setup again',
    async () => {
      // The TypeScript runtime's own `setup` writes the slot, exactly as an
      // install from before the Rust runtime did. `readonly` rather than the
      // default, so reading it back cannot be mistaken for a fresh home.
      const written = Bun.spawn({
        cmd: [process.execPath, TS_RUNTIME_CLI, 'setup', '--slot', 'host', '--profile', 'readonly'],
        env: { ...process.env, MANGO_HOME: mangoHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([
        written.exited,
        new Response(written.stderr).text(),
      ]);
      expect({ exitCode, stderr: stderr.trim() }).toEqual({ exitCode: 0, stderr: '' });
      const configPath = join(mangoHome, 'runtime', 'host', 'runtime.json');
      const stored = await readFile(configPath, 'utf8');
      const user = await insertTestUser();
      manager = localManager();
      const client = await manager.getClient(user.id, LOCAL_ENVIRONMENT_ID);

      const health = await client.health();
      expect(health.slot).toBe('host');
      expect(health.setup?.state).toBe('configured');
      expect(health.profile).toBe('readonly');
      expect(health.allow).toEqual(RUNTIME_CONSENT_PRESETS.readonly);
      expect(client.manifest.features.shell).toBe(false);
      // Connecting neither re-pairs nor rewrites the consent the user gave.
      expect(JSON.parse(await readFile(configPath, 'utf8')).allow).toEqual(
        JSON.parse(stored).allow
      );
    },
    30_000
  );
});
