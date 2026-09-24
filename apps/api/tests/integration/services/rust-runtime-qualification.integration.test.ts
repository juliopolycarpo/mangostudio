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
 * crate deliberately does not build yet (`auditError`, optional on the wire).
 * External-agent admission is qualified in
 * `rust-runtime-external-agents-qualification.integration.test.ts`. The pure-TypeScript
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
 * | `apps/runtime/tests/unit/services/library/library-service.test.ts` "library.read containment" and "library.scan caps" (contained reads, denied outside paths, invalid instances reported) | the workspace tests over stdio, direct URL and paired connect, through `assertRustRuntimeLibraryMethods`, which also diffs the scan against `scanLibraryInstances` on the same tree |
 * | `apps/runtime/tests/unit/services/install.test.ts` "streams lines, writes a bounded raw log, and records success" | "runs, streams and cancels a controlled install through the hub relay over stdio" |
 * | `apps/runtime/tests/unit/services/install.test.ts` "kills a child the hub asked it to cancel" (corrected: cancel stops the chain, the running step finishes) | same test (cancel mid-step, effect applied once) |
 * | `apps/runtime/tests/unit/services/install.test.ts` "stops streaming once the hub session refuses a line, without abandoning the install" | "keeps a running install owned after the hub disconnects from a serve runtime" |
 *
 * **Not yet replaced** — external-agent turns, which the Rust runtime does not
 * serve yet. PTY qualification now lives in the stdio test.
 * GitHub CLI availability and consent revocation are covered here. The paired-connect
 * transport's inventory entries live in the `-connect` sibling file instead.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONSENT_PRESETS,
  runtimeSlotCurrentBinaryPath,
  runtimeSlotCurrentDir,
  runtimeSlotVersionBinaryPath,
} from '@mangostudio/shared/runtime-home';
import { getDb } from '../../../src/db/database';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { evaluateRemoteInstallGuard } from '../../../src/modules/environments/domain/install-guards';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { createTerminalSessionService } from '../../../src/modules/terminals/application/terminal-session-service';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import { openHubSession } from '../../../src/services/runtime-client/hub-session';
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
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import {
  expectAppliedOnce,
  processGone,
  startRelayedInstall,
  waitUntil,
  writeFakeInstaller,
} from '../../support/rust-runtime-install-fixture';

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
      'publishes a verified update through the real Rust stdio runtime',
      async () => {
        mangoHome = await scratchMangoHome('stdio-update');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;
        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-update',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });

        try {
          const client = new RuntimeClient(connection.hub, () => undefined, 'rust-stdio');
          const bytes = Buffer.from('verified runtime bytes');
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          const begun = await client.update.begin({
            version: '9.8.7',
            digest,
            totalBytes: bytes.length,
          });
          const chunked = await client.update.chunk({
            sessionId: begun.sessionId,
            seq: 0,
            bytesBase64: bytes.toString('base64'),
          });
          expect(chunked.receivedBytes).toBe(bytes.length);
          const committed = await client.update.commit({ sessionId: begun.sessionId });
          expect(committed).toEqual({ version: '9.8.7', digest, restart: 'manual' });
          const published =
            process.platform === 'win32'
              ? runtimeSlotVersionBinaryPath('host', '9.8.7', {
                  mangoHome,
                  platform: process.platform,
                })
              : runtimeSlotCurrentBinaryPath('host', { mangoHome, platform: process.platform });
          expect(await readFile(published)).toEqual(bytes);
          if (process.platform === 'win32') {
            const shim = await readFile(
              join(mangoHome, 'runtime', 'host', 'mangostudio-runtime.cmd'),
              'utf8'
            );
            expect(shim).toContain('9.8.7');
          }
        } finally {
          await connection.close();
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'exits 75 after a supervised update has returned its commit response',
      async () => {
        mangoHome = await scratchMangoHome('stdio-supervised-update');
        const oldBinary = runtimeSlotVersionBinaryPath('host', '1.0.0', {
          mangoHome,
          platform: process.platform,
        });
        if (process.platform === 'win32') {
          const installer = Bun.spawn({
            cmd: [binary.path, 'install', '--slot', 'host', '--json'],
            env: { ...process.env, MANGO_HOME: mangoHome },
            stdout: 'ignore',
            stderr: 'pipe',
          });
          const [exitCode, stderr] = await Promise.all([
            installer.exited,
            new Response(installer.stderr).text(),
          ]);
          if (exitCode !== 0) {
            throw new Error(`Windows self-install exited ${exitCode}: ${stderr}`);
          }
        } else {
          await mkdir(dirname(oldBinary), { recursive: true });
          await copyFile(binary.path, oldBinary);
          await symlink('1.0.0', runtimeSlotCurrentDir('host', { mangoHome }));
        }
        const runningBinary =
          process.platform === 'win32'
            ? runtimeSlotVersionBinaryPath('host', runtimeVersion, {
                mangoHome,
                platform: process.platform,
              })
            : oldBinary;
        const peer = spawnPort({
          argv: [runningBinary, '--stdio'],
          env: { MANGO_HOME: mangoHome },
          terminateGraceMs: 2_000,
          killGraceMs: 2_000,
          exitGraceMs: 1_000,
        });
        try {
          const hub = await openHubSession(peer.port, { hubVersion: runtimeVersion });
          const client = new RuntimeClient(hub, () => undefined, 'rust-supervised-update');
          const bytes = Buffer.from('next runtime bytes');
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          const begun = await client.update.begin({
            version: '9.8.8',
            digest,
            totalBytes: bytes.length,
          });
          await client.update.chunk({
            sessionId: begun.sessionId,
            seq: 0,
            bytesBase64: bytes.toString('base64'),
          });
          expect(await client.update.commit({ sessionId: begun.sessionId })).toEqual({
            version: '9.8.8',
            digest,
            restart: 'scheduled',
          });
          const exited = await Promise.race([
            peer.exited,
            Bun.sleep(5_000).then(() => {
              throw new Error('the supervised runtime did not exit after commit');
            }),
          ]);
          expect(exited.code).toBe(75);
          const published =
            process.platform === 'win32'
              ? runtimeSlotVersionBinaryPath('host', '9.8.8', {
                  mangoHome,
                  platform: process.platform,
                })
              : runtimeSlotCurrentBinaryPath('host', { mangoHome });
          expect(await readFile(published)).toEqual(bytes);
          if (process.platform === 'win32') {
            const shim = await readFile(
              join(mangoHome, 'runtime', 'host', 'mangostudio-runtime.cmd'),
              'utf8'
            );
            expect(shim).toContain('9.8.8');
          }
        } finally {
          await peer.terminate();
        }
      },
      45_000
    );

    it.skipIf(!binary.available)(
      'opens a real PTY, streams output and native exit, and closes over stdio',
      async () => {
        mangoHome = await scratchMangoHome('stdio-terminal');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;
        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-terminal',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        try {
          const client = new RuntimeClient(connection.hub, () => undefined, 'rust-stdio-terminal');
          expect(client.manifest.terminal).toBe(true);
          const sessionId = 'rust-pty-qualification';
          const shell = process.platform === 'win32' ? 'powershell' : 'bash';
          // The hub's own admission gate, not just the RPC: the terminal panel must offer this peer.
          const terminals = createTerminalSessionService({
            getConfig: () => ({
              enabled: true,
              idleTimeoutMinutes: 30,
              maxSessionsPerUser: 8,
              scrollbackKib: 256,
            }),
            getRuntimeClient: () => Promise.resolve(client),
            isIdentityAttested: () => true,
            now: Date.now,
            randomId: () => crypto.randomUUID(),
          });
          expect(
            await terminals.availability('rust-qualification-user', 'rust-stdio-terminal')
          ).toMatchObject({ available: true, shells: expect.arrayContaining([shell]) });
          const opened = await client.terminal.open({
            sessionId,
            shell,
            cwd: mangoHome,
            cols: 80,
            rows: 24,
          });
          expect(opened.pid).toBeGreaterThan(0);
          const output: string[] = [];
          let finishExit:
            | ((exit: { exitCode: number | null; signal: string | null }) => void)
            | undefined;
          const exited = new Promise<{ exitCode: number | null; signal: string | null }>(
            (resolve) => {
              finishExit = resolve;
            }
          );
          const unsubscribe = client.terminal.onOutput(sessionId, (event) => {
            if (event.kind === 'data') output.push(Buffer.from(event.data, 'base64').toString());
            if (event.kind === 'exit') finishExit?.(event);
          });
          try {
            expect((await client.terminal.list()).sessions).toHaveLength(1);
            expect((await client.terminal.attach({ sessionId })).status).toBe('running');
            expect(await client.terminal.resize({ sessionId, cols: 100, rows: 40 })).toEqual({
              ok: true,
            });
            expect(
              await client.terminal.write({
                sessionId,
                data: Buffer.from(
                  shell === 'powershell'
                    ? "Write-Output 'rust-pty-ok'; exit 7\r\n"
                    : "printf 'rust-pty-ok\\n'; exit 7\n"
                ).toString('base64'),
              })
            ).toEqual({ ok: true });
            const exit = await Promise.race([
              exited,
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Timed out waiting for Rust PTY exit')), 10_000);
              }),
            ]);
            expect(output.join('')).toContain('rust-pty-ok');
            expect(exit).toMatchObject({ exitCode: 7, signal: null });
            expect(await client.terminal.ack({ sessionId, bytes: 1 })).toEqual({ ok: true });
            expect(await client.terminal.detach({ sessionId })).toEqual({ ok: true });
            const replay = await client.terminal.attach({ sessionId });
            expect(replay.status).toBe('exited');
            expect(Buffer.from(replay.scrollback, 'base64').toString()).toContain('rust-pty-ok');
            expect((await client.terminal.list()).sessions[0]?.exitCode).toBe(7);
            expect(await client.terminal.close({ sessionId })).toEqual({ ok: true });
            expect(await client.terminal.close({ sessionId })).toEqual({ ok: true });
            expect((await client.terminal.list()).sessions).toEqual([]);
          } finally {
            unsubscribe();
            await client.terminal.close({ sessionId });
          }
        } finally {
          await connection.close();
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'revokes an attached PTY with a typed exit and keeps cleanup callable',
      async () => {
        mangoHome = await scratchMangoHome('stdio-terminal-revocation');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;
        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-terminal-revocation',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        try {
          const client = new RuntimeClient(connection.hub, () => undefined, 'rust-stdio-terminal');
          const sessionId = 'rust-pty-revocation';
          await client.terminal.open({
            sessionId,
            shell: process.platform === 'win32' ? 'powershell' : 'bash',
            cwd: mangoHome,
            cols: 80,
            rows: 24,
          });
          let finishExit: ((event: { reason?: string }) => void) | undefined;
          const exited = new Promise<{ reason?: string }>((resolve) => {
            finishExit = resolve;
          });
          const unsubscribe = client.terminal.onOutput(sessionId, (event) => {
            if (event.kind === 'exit') finishExit?.(event);
          });
          try {
            await client.terminal.attach({ sessionId });
            const setup = Bun.spawn({
              cmd: [binary.path, 'setup', '--slot', 'host', '--profile', 'none'],
              env: { ...process.env, MANGO_HOME: mangoHome },
              stdout: 'pipe',
              stderr: 'pipe',
            });
            const [code, stderr] = await Promise.all([
              setup.exited,
              new Response(setup.stderr).text(),
            ]);
            expect(code).toBe(0);
            expect(stderr).toBe('');
            const event = await Promise.race([
              exited,
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Timed out waiting for PTY revocation')), 10_000);
              }),
            ]);
            expect(event.reason).toBe('consent-revoked');
            expect(await client.terminal.close({ sessionId })).toEqual({ ok: true });
          } finally {
            unsubscribe();
            await client.terminal.close({ sessionId });
          }
        } finally {
          await connection.close();
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'workspace, filesystem, snapshot and command methods round-trip over stdio',
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
          await assertRustRuntimeFilesystemMethods(client, dir);
          await assertRustRuntimeWorkspaceMethods(client, dir);
          await assertRustRuntimeSnapshotMethods(client, dir);
          await assertRustRuntimeCommandMethods(client, dir);
          await assertRustRuntimeLibraryMethods(client, dir);
          await cleanupMangoHome(dir);
        } finally {
          await connection.close();
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'runs, streams and cancels a controlled install through the hub relay over stdio',
      async () => {
        mangoHome = await scratchMangoHome('stdio-install');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;
        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-install',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        const scratch = await realpath(await scratchMangoHome('stdio-install-dir'));
        try {
          const client = new RuntimeClient(connection.hub, () => undefined, 'rust-stdio-install');
          // The hub's install gate reads `features.shell !== false`; install is now implemented.
          expect(client.manifest.features.shell).toBe(true);
          expect(
            evaluateRemoteInstallGuard({
              allowInstalls: true,
              installsEnabled: true,
              runtimeShellAllowed: client.manifest.features.shell !== false,
            }).allowed
          ).toBe(true);

          // Cancel during a step: the chain stops, but the running installer is not killed.
          const installer = await writeFakeInstaller(scratch, 'waits', 'cancel-mid-step');
          const abort = new AbortController();
          const run = startRelayedInstall(client, installer, {
            runId: 'rust-install-cancel',
            signal: abort.signal,
          });
          await run.waitForLine('stdout', 'waiting');
          await run.waitForLine('stderr', 'warn');
          abort.abort('user_cancelled');
          await run.waitForLine('system', 'Cancellation requested');
          await writeFile(installer.release, '');
          const result = await run.result;
          expect(result).toMatchObject({ status: 'succeeded', exitCode: 0, truncated: false });
          expect(run.lines).toContainEqual({ stream: 'stdout', line: 'done' });
          await expectAppliedOnce(installer, run);
          const log = await readFile(installer.logPath, 'utf8');
          expect(log).toContain('waiting');
          expect(log).toContain('done');

          if (process.platform === 'win32') {
            // Extra interpreter case: a cmd.exe batch installer relays the same way.
            const batch = await writeFakeInstaller(scratch, 'sleeps', 'cmd-installer', 'cmd');
            const batchRun = startRelayedInstall(client, batch, { runId: 'rust-install-cmd' });
            expect(await batchRun.result).toMatchObject({ status: 'succeeded', exitCode: 0 });
            expect(batchRun.lines).toContainEqual({ stream: 'stdout', line: 'done' });
            await expectAppliedOnce(batch, batchRun);
          }

          // Cancel before its run arrives: nothing launches.
          const early = await writeFakeInstaller(scratch, 'sleeps', 'cancel-before-run');
          expect(await client.install.cancel({ runId: 'rust-install-early' })).toEqual({
            ok: true,
          });
          const cancelled = await client.install.run({
            runId: 'rust-install-early',
            argv: [...early.argv],
            timeoutMs: 20_000,
            logPath: early.logPath,
          });
          expect(cancelled).toMatchObject({ status: 'cancelled', exitCode: null });
          await Bun.sleep(1_500);
          expect(await Bun.file(early.marker).exists()).toBe(false);
        } finally {
          await connection.close();
          await cleanupMangoHome(scratch);
        }
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'finishes an install step after the old four-second stop window',
      async () => {
        mangoHome = await scratchMangoHome('stdio-install-hub-loss');
        previousMangoHome = process.env.MANGO_HOME;
        process.env.MANGO_HOME = mangoHome;
        const connection = await spawnRuntimeChild({
          environmentId: 'rust-stdio-install-hub-loss',
          launch: resolveRuntimeLaunchCommand(undefined, {
            MANGOSTUDIO_RUNTIME_BINARY: binary.path,
          }),
          hubVersion: runtimeVersion,
          onClosed: () => undefined,
        });
        const scratch = await realpath(await scratchMangoHome('stdio-install-hub-loss-dir'));
        try {
          const client = new RuntimeClient(
            connection.hub,
            () => undefined,
            'rust-stdio-install-hub-loss'
          );
          const installer = await writeFakeInstaller(scratch, 'waits', 'hub-loss');
          const run = startRelayedInstall(client, installer, { runId: 'rust-install-hub-loss' });
          await run.waitForLine('stdout', 'waiting');

          // Closing the session marks the chain stopping. The active step
          // still has time to finish after the former four-second cap.
          const closed = connection.close();
          await Bun.sleep(5_000);
          await writeFile(installer.release, 'finish');
          await closed;
          await run.result;
          await expectAppliedOnce(installer, run);
          expect(await readFile(installer.logPath, 'utf8')).toContain('done');
        } finally {
          await connection.close();
          await cleanupMangoHome(scratch);
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
            checkpoints: true,
            mcp: true,
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
          checkpoints: true,
          mcp: true,
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
          checkpoints: true,
          mcp: true,
        });
        const refreshed = await manager.refreshManifest(TEST_USER.id, 'rust-serve-refresh-box');
        expect(refreshed.state).toBe('connected');
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: true,
          fsRead: true,
          fsWrite: true,
          checkpoints: true,
          mcp: true,
        });

        await setRustRuntimeProfile(mangoHome, 'none');

        const revoked = await manager.refreshManifest(TEST_USER.id, 'rust-serve-refresh-box');
        expect(revoked.manifest?.allow).toEqual(RUNTIME_CONSENT_PRESETS.none);
        expect(revoked.manifest?.gh?.available).toBe(false);
        expect((await client.health()).gh?.available).toBe(false);
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: false,
          fsRead: false,
          fsWrite: false,
          checkpoints: false,
          mcp: false,
        });

        await setRustRuntimeProfile(mangoHome, 'full');
        const restored = await manager.refreshManifest(TEST_USER.id, 'rust-serve-refresh-box');
        expect(restored.manifest?.allow).toEqual(RUNTIME_CONSENT_PRESETS.full);
        assertRustRuntimeFeatureCeiling(client.manifest, {
          probing: true,
          fsRead: true,
          fsWrite: true,
          checkpoints: true,
          mcp: true,
        });
      },
      30_000
    );

    it.skipIf(!binary.available)(
      'workspace, filesystem, snapshot and command methods round-trip over a direct URL serve connection',
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
        await assertRustRuntimeFilesystemMethods(client, dir);
        await assertRustRuntimeWorkspaceMethods(client, dir);
        await assertRustRuntimeSnapshotMethods(client, dir);
        await assertRustRuntimeCommandMethods(client, dir);
        await assertRustRuntimeLibraryMethods(client, dir);
        await cleanupMangoHome(dir);
      },
      30_000
    );

    /** Starts `serve` under a scratch home and returns a connected hub client. */
    async function connectServe(name: string) {
      await insertTestUser(TEST_USER);
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      const token = `rust-serve-${name}-token`;
      mangoHome = await scratchMangoHome(`serve-${name}`);
      const port = reserveEphemeralPort();
      child = Bun.spawn({
        cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
        env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const repository = createEnvironmentRepository(getDb());
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
        connectors: { http: connectHttpRuntime },
      });
      setRuntimeConnectionManagerForTests(manager);
      const service = createEnvironmentService(repository, manager, () => undefined, store);
      const environmentId = `rust-serve-${name}-box`;
      await service.create(TEST_USER.id, {
        id: environmentId,
        name: `Rust serve ${name} box`,
        transportKind: 'http',
        config: { baseUrl: `http://127.0.0.1:${port}` },
        token,
      });
      await connectUntilListening(() => service.connect(TEST_USER.id, environmentId));
      const client = await manager.getClient(TEST_USER.id, environmentId);
      return { client, disconnect: () => manager.disconnect(TEST_USER.id, environmentId) };
    }

    it.skipIf(!binary.available)(
      'keeps a running install owned after the hub disconnects from a serve runtime',
      async () => {
        const { client, disconnect } = await connectServe('install-hub-loss');
        const scratch = await realpath(await scratchMangoHome('serve-install-hub-loss-dir'));
        try {
          const installer = await writeFakeInstaller(scratch, 'waits', 'serve-hub-loss');
          const run = startRelayedInstall(client, installer, { runId: 'rust-serve-hub-loss' });
          await run.waitForLine('stdout', 'waiting');

          disconnect();
          await run.result;
          await writeFile(installer.release, '');
          await expectAppliedOnce(installer, run);
          await waitUntil(
            () => Bun.file(installer.logPath).size > 0,
            'the install log to keep the unobserved output'
          );
          // No request was left to answer, so the owner wrote the audit line itself.
          const audit = join(mangoHome, 'runtime', 'remote', 'audit.log');
          await waitUntilAsync(async () => {
            const text = await readFile(audit, 'utf8').catch(() => '');
            return text.includes('"method":"install.run"');
          }, 'an install.run audit line recorded by the run owner');
          expect(await readFile(installer.logPath, 'utf8')).toContain('done');
        } finally {
          await cleanupMangoHome(scratch);
        }
      },
      30_000
    );

    it.skipIf(!binary.available || process.platform === 'win32')(
      'terminates a running install tree when the runtime process is signalled',
      async () => {
        const { client } = await connectServe('install-signal');
        const scratch = await realpath(await scratchMangoHome('serve-install-signal-dir'));
        try {
          const installer = await writeFakeInstaller(scratch, 'grandchild', 'serve-signal');
          const run = startRelayedInstall(client, installer, { runId: 'rust-serve-signal' });
          await run.waitForLine('stdout', 'waiting');
          await waitUntil(() => Bun.file(installer.pidFile).size > 0, 'the grandchild pid');
          const pid = Number((await readFile(installer.pidFile, 'utf8')).trim());

          child?.kill('SIGTERM');
          await child?.exited;
          child = undefined;
          await run.result;

          expect(await processGone(pid)).toBe(true);
        } finally {
          await cleanupMangoHome(scratch);
        }
      },
      30_000
    );
  });
});

/** {@link waitUntil} for an asynchronous condition. */
async function waitUntilAsync(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`expected ${what} | received: nothing within ${timeoutMs}ms`);
    }
    await Bun.sleep(20);
  }
}

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
