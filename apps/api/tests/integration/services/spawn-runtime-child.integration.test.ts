/**
 * Exercises the stdio transport against a real `mangostudio-runtime` child.
 *
 * A standalone install runs the sibling binary; here the launcher falls back to
 * the workspace entry under Bun, so these tests cover the same spawn, handshake,
 * and teardown path the shipped binary takes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';

const RUNTIME_ENTRY = join(import.meta.dir, '../../../../runtime/src/cli.ts');
const hasRuntimeEntry = existsSync(RUNTIME_ENTRY);
const hasPosixShell = process.platform !== 'win32';
const canSpawnRuntime = hasRuntimeEntry && hasPosixShell;

const SHELL_DEFAULTS = { kind: 'bash', timeoutMs: 10_000, maxOutputBytes: 65_536 } as const;

let workdir = '';

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-stdio-runtime-'));
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
});

describe('spawnRuntimeChild', () => {
  it.skipIf(!hasRuntimeEntry)(
    'handshakes with a spawned runtime and runs a method',
    async () => {
      const connection = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: resolveRuntimeLaunchCommand(),
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      });

      try {
        expect(connection.client.manifest.pathStyle).toBe(
          process.platform === 'win32' ? 'win32' : 'posix'
        );
        expect(connection.client.manifest.features.tools).toBe(true);

        const path = join(workdir, 'hello.txt');
        await writeFile(path, 'from the runtime\n');
        const result = await connection.client.request('fs.read-file', {
          chatId: 'chat-1',
          inputPath: path,
          resolvedPath: path,
        });
        expect(result.content).toContain('from the runtime');
      } finally {
        connection.close();
      }
    },
    30_000
  );

  it.skipIf(!canSpawnRuntime)(
    'runs the child in the configured working directory',
    async () => {
      const connection = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: resolveRuntimeLaunchCommand(),
        cwd: workdir,
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      });

      try {
        const result = await connection.client.request('shell.run', {
          ...SHELL_DEFAULTS,
          command: 'pwd',
        });
        expect(result.stdout).toContain('mango-stdio-runtime-');
      } finally {
        connection.close();
      }
    },
    30_000
  );

  it.skipIf(!canSpawnRuntime)(
    'withholds hub secrets from the child environment',
    async () => {
      const connection = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: resolveRuntimeLaunchCommand(),
        hubVersion: 'hub-test',
        onClosed: () => undefined,
      });

      try {
        const result = await connection.client.request('shell.run', {
          ...SHELL_DEFAULTS,
          command: 'printenv BETTER_AUTH_SECRET || true',
        });
        expect(result.stdout.trim()).toBe('');
      } finally {
        connection.close();
      }
    },
    30_000
  );

  it.skipIf(!canSpawnRuntime)(
    'reports a lost runtime once, with in-flight calls failing cleanly',
    async () => {
      let closedCount = 0;
      const connection = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: resolveRuntimeLaunchCommand(),
        hubVersion: 'hub-test',
        onClosed: () => {
          closedCount += 1;
        },
      });

      const inFlight = connection.client.request('shell.run', {
        ...SHELL_DEFAULTS,
        command: 'sleep 5',
      });
      // Kill the runtime from inside itself: a crash mid-call, not a shutdown.
      void connection.client
        .request('shell.run', { ...SHELL_DEFAULTS, command: 'kill -9 $PPID' })
        .catch(() => undefined);

      await expect(inFlight).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
      expect(closedCount).toBe(1);

      // A close after the loss must stay silent rather than reporting it twice.
      connection.close();
      expect(closedCount).toBe(1);
    },
    30_000
  );

  it('fails with an actionable message when the binary is missing', async () => {
    const missing = join(workdir, 'no-such-runtime');
    const error = await spawnRuntimeChild({
      environmentId: 'devbox',
      launch: resolveRuntimeLaunchCommand(missing),
      hubVersion: 'hub-test',
      handshakeTimeoutMs: 5_000,
      onClosed: () => undefined,
    }).catch((caught) => caught);

    expect(error.code).toBe('RUNTIME_UNAVAILABLE');
    expect(error.message).toContain(missing);
    expect(error.message).toContain('Reinstall MangoStudio');
  }, 30_000);

  it('fails on handshake when the spawned child does not speak the protocol', async () => {
    // Bun rejects `--stdio`, so the child starts and exits without a hello.
    const error = await spawnRuntimeChild({
      environmentId: 'devbox',
      launch: resolveRuntimeLaunchCommand(process.execPath),
      hubVersion: 'hub-test',
      handshakeTimeoutMs: 2_000,
      onClosed: () => undefined,
    }).catch((caught) => caught);

    expect(error.code).toBe('RUNTIME_UNAVAILABLE');
    expect(error.message).toContain('handshake');
  }, 30_000);
});
