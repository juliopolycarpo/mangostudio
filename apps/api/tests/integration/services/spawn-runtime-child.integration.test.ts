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
import type { RemoteError } from '@mangostudio/protocol';
import { rejectionOf } from '@mangostudio/protocol/testing';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';

const RUNTIME_ENTRY = join(import.meta.dir, '../../../../runtime/src/cli.ts');
const hasRuntimeEntry = existsSync(RUNTIME_ENTRY);
const isWindows = process.platform === 'win32';
const hasPosixShell = !isWindows;
const canSpawnRuntime = hasRuntimeEntry && hasPosixShell;

const SHELL_DEFAULTS = { kind: 'bash', timeoutMs: 10_000, maxOutputBytes: 65_536 } as const;

/**
 * What the child will announce: it inherits this process's environment, so the
 * two resolve the version the same way. The handshake refuses a hub and runtime
 * from different releases, so anything that expects to connect must match it.
 */
const RUNTIME_VERSION = process.env.VERSION || 'dev';

/**
 * A child that starts, says nothing, and would outlive the launch that gave up
 * on it. It announces its pid on stderr — which the launcher puts in the
 * failure message — so every test that spawns one can prove it was reaped
 * rather than leaking a process per run.
 */
const NEVER_GREETING_CHILD =
  'process.stderr.write("pid=" + process.pid + "\\n"); setInterval(() => {}, 1_000);';

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
        hubVersion: RUNTIME_VERSION,
        onClosed: () => undefined,
      });

      try {
        expect(connection.hub.manifest.pathStyle).toBe(
          process.platform === 'win32' ? 'win32' : 'posix'
        );
        expect(connection.hub.manifest.features.tools).toBe(true);

        const path = join(workdir, 'hello.txt');
        await writeFile(path, 'from the runtime\n');
        const result = await connection.hub.request('fs.read-file', {
          chatId: 'chat-1',
          inputPath: path,
          resolvedPath: path,
        });
        expect(result.content).toContain('from the runtime');
      } finally {
        await connection.close();
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
        hubVersion: RUNTIME_VERSION,
        onClosed: () => undefined,
      });

      try {
        const result = await connection.hub.request('shell.run', {
          ...SHELL_DEFAULTS,
          command: 'pwd',
        });
        expect(result.stdout).toContain('mango-stdio-runtime-');
      } finally {
        await connection.close();
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
        hubVersion: RUNTIME_VERSION,
        onClosed: () => undefined,
      });

      try {
        const result = await connection.hub.request('shell.run', {
          ...SHELL_DEFAULTS,
          command: 'printenv BETTER_AUTH_SECRET || true',
        });
        expect(result.stdout.trim()).toBe('');
      } finally {
        await connection.close();
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
        hubVersion: RUNTIME_VERSION,
        onClosed: () => {
          closedCount += 1;
        },
      });

      const inFlight = connection.hub.request('shell.run', {
        ...SHELL_DEFAULTS,
        command: 'sleep 5',
      });
      // Kill the runtime from inside itself: a crash mid-call, not a shutdown.
      void connection.hub
        .request('shell.run', { ...SHELL_DEFAULTS, command: 'kill -9 $PPID' })
        .catch(() => undefined);

      expect(await rejectionOf(inFlight)).toMatchObject({ code: 'UNAVAILABLE' });
      expect(closedCount).toBe(1);

      // A close after the loss must stay silent rather than reporting it twice.
      await connection.close();
      expect(closedCount).toBe(1);
    },
    30_000
  );

  it.skipIf(!hasRuntimeEntry)(
    'refuses a runtime left over from a different release',
    async () => {
      // Same protocol, different release: the wire format still parses, so only
      // the release comparison can catch a binary an old install left behind.
      const error = (await rejectionOf(
        spawnRuntimeChild({
          environmentId: 'devbox',
          launch: resolveRuntimeLaunchCommand(),
          hubVersion: `${RUNTIME_VERSION}-other`,
          onClosed: () => undefined,
        })
      )) as RemoteError;

      expect(error.code).toBe('PROTOCOL_MISMATCH');
      // The protocol says what disagreed; the launcher adds the fix, because it
      // is the one that asked for release equality in the first place.
      expect(error.message).toBe(
        `Runtime reports version ${RUNTIME_VERSION}; this hub is ${RUNTIME_VERSION}-other. ` +
          'A hub-managed runtime must be the same release. ' +
          'Reinstall MangoStudio so the hub and runtime come from the same release.'
      );
    },
    30_000
  );

  it.skipIf(!hasRuntimeEntry)(
    'connects across releases when the launcher does not own the binary',
    async () => {
      // The counterpart to the test above, which pins the default: a runtime on
      // someone else's machine is not part of this hub's distribution, so
      // release equality cannot gate it and the protocol version is what does.
      const connection = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: resolveRuntimeLaunchCommand(),
        hubVersion: `${RUNTIME_VERSION}-other`,
        requireMatchingRelease: false,
        onClosed: () => undefined,
      });

      try {
        expect(connection.hub.runtimeVersion).toBe(RUNTIME_VERSION);
      } finally {
        await connection.close();
      }
    },
    30_000
  );

  it.skipIf(!hasPosixShell)(
    'hands a launcher the exit status and stderr of the wrapper it ran',
    async () => {
      // What an SSH launch needs to tell "no binary on that host" (127) from
      // "the host refused the connection" (255) — neither of which the hub can
      // see from a closed pipe alone.
      const seen: { exitCode?: number | null; stderr?: string; command?: string } = {};
      const error = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: { command: 'sh', args: ['-c', 'echo "no such file" >&2; exit 127'] },
        hubVersion: 'hub-test',
        handshakeTimeoutMs: 5_000,
        describeFailure: (failure) => {
          seen.exitCode = failure.exitCode;
          seen.stderr = failure.stderr;
          seen.command = failure.command;
          return 'the launcher said so';
        },
        onClosed: () => undefined,
      }).catch((caught) => caught);

      expect(seen.exitCode).toBe(127);
      expect(seen.stderr).toContain('no such file');
      expect(seen.command).toBe('sh');
      expect(error.message).toBe('the launcher said so');
    },
    30_000
  );

  it('keeps the built-in message when a launcher has nothing to add', async () => {
    const missing = join(workdir, 'no-such-runtime');
    const error = await spawnRuntimeChild({
      environmentId: 'devbox',
      launch: resolveRuntimeLaunchCommand(missing),
      hubVersion: 'hub-test',
      handshakeTimeoutMs: 5_000,
      describeFailure: () => undefined,
      onClosed: () => undefined,
    }).catch((caught) => caught);

    expect(error.message).toContain(missing);
  }, 30_000);

  it.skipIf(!canSpawnRuntime)(
    'blames the working directory rather than the binary when the cwd is gone',
    async () => {
      const error = await spawnRuntimeChild({
        environmentId: 'devbox',
        launch: resolveRuntimeLaunchCommand(),
        cwd: join(workdir, 'no-such-directory'),
        hubVersion: RUNTIME_VERSION,
        handshakeTimeoutMs: 5_000,
        onClosed: () => undefined,
      }).catch((caught) => caught);

      expect(error.message).toContain('no-such-directory');
      // Reinstalling would not help; the configured directory is the problem.
      expect(error.message).not.toContain('Reinstall MangoStudio');
    },
    30_000
  );

  it('fails with an actionable message when the binary is missing', async () => {
    // No `handshakeTimeoutMs`, so this runs on whatever the default budget is —
    // 30s on a Windows hub. The elapsed assertion is what that budget rests on:
    // a child that never starts closes its port at once, `openHubSession`
    // rejects on the closure, and the handshake timer never fires. Take the
    // override away and this test is also the proof that raising the Windows
    // budget did not make a broken install wait it out.
    const missing = join(workdir, 'no-such-runtime');
    const startedAt = performance.now();
    const error = await spawnRuntimeChild({
      environmentId: 'devbox',
      launch: resolveRuntimeLaunchCommand(missing),
      hubVersion: 'hub-test',
      onClosed: () => undefined,
    }).catch((caught) => caught);
    const elapsedMs = performance.now() - startedAt;

    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toContain(missing);
    expect(error.message).toContain('Reinstall MangoStudio');
    // Generous against a loaded runner, and still far below every budget in
    // play: 5s on this runner, up to 30s on a Windows one.
    expect(elapsedMs).toBeLessThan(2_000);
    // Longer than the 30s budget plus the exit-observation grace on purpose. If
    // a broken Windows install ever stops failing fast, this has to fail on the
    // elapsed assertion — which names the budget it blew — rather than on the
    // runner's own timeout, which would only say the test took too long.
  }, 40_000);

  it.skipIf(!hasPosixShell)(
    'reaps a child that started but never handshaked',
    async () => {
      // The launcher terminates the child whenever its port closes, and a
      // failed handshake closes it — so nothing here asks for a termination.
      // A child that outlived its rejected connection would be a runtime this
      // hub can no longer reach and no longer stop.
      const error = (await rejectionOf(
        spawnRuntimeChild({
          environmentId: 'devbox',
          launch: { command: process.execPath, args: ['-e', NEVER_GREETING_CHILD] },
          hubVersion: 'hub-test',
          handshakeTimeoutMs: 1_000,
          onClosed: () => undefined,
        })
      )) as RemoteError;

      await expect(whenProcessGone(announcedPid(error))).resolves.toBeUndefined();
    },
    30_000
  );

  // Skipped on Windows, and not for want of a shell — the child is
  // `process.execPath -e`. The assertion is the *non*-win32 default, so a
  // `win32` runner would be asserting 30_000 and waiting 30s to do it.
  it.skipIf(isWindows)(
    'bounds a never-greeting child by the default budget when no timeout is given',
    async () => {
      // What this buys over the unit test is the wiring, not the number. 5_000
      // is what the old literal said too — but mutate the resolver's default and
      // this test moves with it, which it can only do if `spawnRuntimeChild`
      // reads the resolver instead of a constant of its own. That, plus the unit
      // test's `win32` case, leaves only `process.platform === 'win32'` unproven
      // on a Windows host.
      // ~7s on purpose: the 5s budget and the 250ms exit-observation grace
      // before the rejection, then the launcher's 2s terminate grace before the
      // child is gone. Well inside this file's 30s per-test timeout. It is the
      // cost of the assertions, not slack to trim.
      const error = (await rejectionOf(
        spawnRuntimeChild({
          environmentId: 'devbox',
          launch: { command: process.execPath, args: ['-e', NEVER_GREETING_CHILD] },
          hubVersion: 'hub-test',
          onClosed: () => undefined,
        })
      )) as RemoteError;

      // `spawnRuntimeChild` rewrites the message but keeps the protocol error's
      // details, which is where the budget it actually waited on is recorded.
      expect(error.details?.timeoutMs).toBe(5_000);
      // The rejection lands on the exit-observation grace, well before the
      // launcher escalates — so returning here would leave an immortal child
      // behind, and the test runner exiting is what it would outlive. Measured:
      // without this wait the file leaks one `bun -e` process per run.
      await expect(whenProcessGone(announcedPid(error))).resolves.toBeUndefined();
    },
    30_000
  );

  it('fails on handshake when the spawned child does not speak the protocol', async () => {
    // Bun rejects `--stdio`, so the child starts and exits without a hello.
    const error = await spawnRuntimeChild({
      environmentId: 'devbox',
      launch: resolveRuntimeLaunchCommand(process.execPath),
      hubVersion: 'hub-test',
      handshakeTimeoutMs: 2_000,
      onClosed: () => undefined,
    }).catch((caught) => caught);

    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toContain('handshake');
  }, 30_000);
});

/**
 * The pid a {@link NEVER_GREETING_CHILD} announced, read off the launch failure
 * the launcher built from its stderr tail.
 *
 * @example
 * await whenProcessGone(announcedPid(error));
 */
function announcedPid(error: RemoteError): number {
  const pid = Number(/pid=(\d+)/.exec(error.message)?.[1]);
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

/**
 * Settles once `pid` is gone, and rejects naming it when it is still running
 * after the launcher's own terminate grace has had time to escalate.
 *
 * @example
 * await whenProcessGone(child.pid);
 */
async function whenProcessGone(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Process ${pid} is still running ${timeoutMs}ms after its launch failed.`);
}
