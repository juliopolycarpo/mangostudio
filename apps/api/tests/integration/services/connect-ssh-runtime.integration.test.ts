/**
 * Exercises the SSH launcher against a real sshd, reached at `localhost`.
 *
 * The framing is the stdio transport's and is covered by its own conformance
 * suite; what only a real client and server can prove is the launcher — that
 * the forced options are accepted, that the argv survives the trip through the
 * target's login shell, and that a failure on the far side comes back as
 * something a user can act on rather than as exit 255.
 *
 * Self-skipping, like the Git suites: a machine with no sshd listening, or one
 * whose own host key has never been accepted, cannot run these and must not
 * fail because of it.
 *
 * `MANGOSTUDIO_SSH_FIXTURE=1` is the opposite contract, for CI and for a
 * developer who wants the cases to run: the suite starts a throwaway sshd of
 * its own (see `tests/support/ssh-fixture.ts`) and anything missing — sshd, the
 * runtime binary, a working key login — fails the file with the reason instead
 * of skipping. Locally:
 *
 *   MANGOSTUDIO_SSH_FIXTURE=1 bun run --filter @mangostudio/api test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';

import { connectSshRuntime } from '../../../src/services/runtime-client/connect-ssh-runtime';
import { resolveRustRuntimeBinary } from '../../support/rust-runtime-binary';
import {
  probeLocalhostSsh,
  sshFixtureRequested,
  sshTargetFor,
  startSshFixtureIfRequested,
} from '../../support/ssh-fixture-suite';

/** The compiled runtime the wrapper execs: CI's override, or this checkout's newest build. */
const binary = resolveRustRuntimeBinary();
const SHELL_DEFAULTS = { kind: 'bash', timeoutMs: 10_000, maxOutputBytes: 65_536 } as const;

if (sshFixtureRequested(process.env) && !binary.available) {
  throw new Error(
    `MANGOSTUDIO_SSH_FIXTURE=1: expected a runtime binary at ${binary.path} | received: none. ` +
      'Build it with "cargo build -p mangostudio-runtime --locked" or set MANGOSTUDIO_RUNTIME_BINARY.'
  );
}
/** Started at load because `skipIf` below is decided at collection time. */
const fixture = await startSshFixtureIfRequested(process.env, afterAll);

/**
 * The fixture has already proved its own key login, so it needs no probe; the
 * machine's own localhost is probed as the hub would open it.
 */
const canReachLocalhost =
  fixture !== undefined || (binary.available && (await probeLocalhostSsh()));

let workdir = '';
let runtimePath = '';

/** A shell script that execs the compiled runtime with whatever arguments it got. */
function runtimeWrapper(): string {
  return `#!/bin/sh\nexec '${binary.path.replaceAll("'", "'\\''")}' "$@"\n`;
}

/** `localhost` as the machine's own sshd knows it, or the throwaway server's address and key. */
function sshConfig(overrides: Partial<SshEnvironmentConfig> = {}): SshEnvironmentConfig {
  return { ...sshTargetFor(fixture), remoteRuntimePath: runtimePath, ...overrides };
}

/** The hub's real launcher; only the fixture's trust options are put in front of `ssh`. */
function connectToSsh(config: SshEnvironmentConfig) {
  return connectSshRuntime(
    { userId: 'test-user', id: 'ssh-box', config },
    () => undefined,
    {},
    fixture ? { spawnPort: (options) => fixture.spawnPort(options) } : {}
  );
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-ssh-runtime-'));
  // The "installed runtime" is a wrapper that execs the compiled binary, so
  // the test can name the path the launcher receives. The path is absolute on
  // purpose: a non-interactive ssh session gets a minimal PATH.
  runtimePath = join(workdir, 'mangostudio-runtime');
  await writeFile(runtimePath, runtimeWrapper());
  await chmod(runtimePath, 0o755);
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
});

describe('connectSshRuntime over a real sshd', () => {
  it.skipIf(!canReachLocalhost)(
    'handshakes with a runtime on the far side of the ssh pipe',
    async () => {
      const connection = await connectToSsh(sshConfig());

      try {
        expect(connection.client.manifest.pathStyle).toBe('posix');
        expect(connection.client.manifest.features.tools).toBe(true);
      } finally {
        await connection.close();
      }
    },
    60_000
  );

  it.skipIf(!canReachLocalhost)(
    'runs a shell command on the target rather than on the hub',
    async () => {
      const connection = await connectToSsh(sshConfig());

      try {
        const result = await connection.client.shell.run({
          ...SHELL_DEFAULTS,
          command: 'printf %s ran-over-ssh',
        });
        expect(result.stdout).toContain('ran-over-ssh');
      } finally {
        await connection.close();
      }
    },
    60_000
  );

  it.skipIf(!canReachLocalhost)(
    'connects to a runtime whose release differs from the hub',
    async () => {
      // The wrapper's runtime reports whatever the ssh session's environment
      // says, which is not this process's. Release equality is deliberately not
      // a gate for a machine the hub does not install onto.
      const connection = await connectToSsh(sshConfig());

      try {
        expect(connection.client.runtimeVersion.length).toBeGreaterThan(0);
      } finally {
        await connection.close();
      }
    },
    60_000
  );

  it.skipIf(!canReachLocalhost)(
    'survives a runtime path containing a space',
    async () => {
      // The remote command is joined and handed to a login shell, so an
      // unquoted path would arrive as two words and start nothing.
      const spaced = join(workdir, 'mango studio runtime');
      await writeFile(spaced, runtimeWrapper());
      await chmod(spaced, 0o755);

      const connection = await connectToSsh(sshConfig({ remoteRuntimePath: spaced }));

      try {
        expect(connection.client.manifest.features.tools).toBe(true);
      } finally {
        await connection.close();
      }
    },
    60_000
  );

  it.skipIf(!canReachLocalhost)(
    'runs nothing when the runtime path carries shell metacharacters',
    async () => {
      const marker = join(workdir, 'injected');
      const error = await connectToSsh(
        sshConfig({ remoteRuntimePath: `/bin/true; touch ${marker}` })
      ).catch((caught) => caught);

      expect({ code: error.code, message: error.message, details: error.details }).toMatchObject({
        code: 'UNAVAILABLE',
        details: { sshFailureReason: 'runtime-missing' },
      });
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    60_000
  );

  it.skipIf(!canReachLocalhost)(
    'says a runtime is missing rather than that the connection failed',
    async () => {
      const error = await connectToSsh(
        sshConfig({ remoteRuntimePath: join(workdir, 'absent') })
      ).catch((caught) => caught);

      expect({ code: error.code, message: error.message, details: error.details }).toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringContaining('absent'),
        details: { sshFailureReason: 'runtime-missing' },
      });
    },
    60_000
  );
});
