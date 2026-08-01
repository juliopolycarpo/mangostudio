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
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';
import { connectSshRuntime } from '../../../src/services/runtime-client/connect-ssh-runtime';

const RUNTIME_ENTRY = join(import.meta.dir, '../../../../runtime/src/cli.ts');
const SHELL_DEFAULTS = { kind: 'bash', timeoutMs: 10_000, maxOutputBytes: 65_536 } as const;

const hasSshClient = Bun.which('ssh') !== null;
/**
 * The same connection the hub will open: batch mode, and a host key that must
 * already be trusted. Probing with anything laxer would let the suite run under
 * conditions the launcher itself refuses.
 */
const canReachLocalhost = hasSshClient && (await probeLocalhost());

let workdir = '';
let runtimePath = '';

async function probeLocalhost(): Promise<boolean> {
  const child = Bun.spawn(
    [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      '-T',
      '--',
      'localhost',
      'true',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  return (await child.exited) === 0;
}

function sshConfig(overrides: Partial<SshEnvironmentConfig> = {}): SshEnvironmentConfig {
  return { host: 'localhost', remoteRuntimePath: runtimePath, ...overrides };
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-ssh-runtime-'));
  // A source checkout has no compiled runtime to place on a host, so the
  // "installed runtime" is a wrapper that runs the workspace entry. Both paths
  // are absolute on purpose: a non-interactive ssh session gets a minimal PATH
  // and need not have `bun` on it.
  runtimePath = join(workdir, 'mangostudio-runtime');
  await writeFile(
    runtimePath,
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${RUNTIME_ENTRY.replaceAll("'", "'\\''")}' "$@"\n`
  );
  await chmod(runtimePath, 0o755);
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
});

describe('connectSshRuntime over a real sshd', () => {
  it.skipIf(!canReachLocalhost)(
    'handshakes with a runtime on the far side of the ssh pipe',
    async () => {
      const connection = await connectSshRuntime(
        { id: 'ssh-box', config: sshConfig() },
        () => undefined
      );

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
      const connection = await connectSshRuntime(
        { id: 'ssh-box', config: sshConfig() },
        () => undefined
      );

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
      const connection = await connectSshRuntime(
        { id: 'ssh-box', config: sshConfig() },
        () => undefined
      );

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
      await writeFile(
        spaced,
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${RUNTIME_ENTRY.replaceAll("'", "'\\''")}' "$@"\n`
      );
      await chmod(spaced, 0o755);

      const connection = await connectSshRuntime(
        { id: 'ssh-box', config: sshConfig({ remoteRuntimePath: spaced }) },
        () => undefined
      );

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
      const error = await connectSshRuntime(
        {
          id: 'ssh-box',
          config: sshConfig({ remoteRuntimePath: `/bin/true; touch ${marker}` }),
        },
        () => undefined
      ).catch((caught) => caught);

      expect(error.details?.sshFailureReason).toBe('runtime-missing');
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    60_000
  );

  it.skipIf(!canReachLocalhost)(
    'says a runtime is missing rather than that the connection failed',
    async () => {
      const error = await connectSshRuntime(
        { id: 'ssh-box', config: sshConfig({ remoteRuntimePath: join(workdir, 'absent') }) },
        () => undefined
      ).catch((caught) => caught);

      expect(error.code).toBe('RUNTIME_UNAVAILABLE');
      expect(error.details?.sshFailureReason).toBe('runtime-missing');
      expect(error.message).toContain('absent');
    },
    60_000
  );

  it.skipIf(!hasSshClient)(
    'classifies a host that does not resolve without needing one to exist',
    async () => {
      const error = await connectSshRuntime(
        { id: 'ssh-box', config: { host: 'mangostudio-ssh-target.invalid' } },
        () => undefined
      ).catch((caught) => caught);

      expect(error.details?.sshFailureReason).toBe('unreachable');
      expect(error.message).toContain('mangostudio-ssh-target.invalid');
    },
    60_000
  );
});
