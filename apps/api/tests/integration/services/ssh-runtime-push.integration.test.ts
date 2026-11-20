/**
 * SSH push / setup checks against a real sshd.
 *
 * Isolates the remote mango home under a temporary directory so the test never
 * overwrites the developer's real `remote` slot under ~/.mango.
 *
 * Without `MANGOSTUDIO_SSH_FIXTURE=1` the real-server cases self-skip on a
 * machine whose localhost sshd does not trust the caller. With it, the suite
 * starts a throwaway sshd of its own (`tests/support/ssh-fixture.ts`) and a
 * missing sshd or a broken login fails the file with the cause instead.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';
import { quoteForRemoteShell } from '@mangostudio/shared/environments';
import {
  parsePlatformProbe,
  PLATFORM_PROBE_SCRIPT,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';

import {
  pushRuntimeBinary,
  type RuntimeCommandOptions,
  type RuntimeCommandRunner,
} from '../../../src/modules/environments/domain/runtime-push';
import { removeFixtureDir } from '../../support/remove-fixture-dir';
import {
  probeLocalhostSsh,
  sshCommandRunnerFor,
  sshTargetFor,
  startSshFixtureIfRequested,
} from '../../support/ssh-fixture-suite';

let workdir = '';
let fakeBinary = new Uint8Array();
let remoteHome = '';
let isolatedRunner: RuntimeCommandRunner | null = null;

// `afterAll` hooks run in registration order and this one still needs the
// server, so it is registered before the fixture's own stop.
afterAll(async () => {
  if (workdir) await removeFixtureDir({ role: 'ssh-runtime-push', path: workdir });
  if (canReachLocalhost && remoteHome) {
    await runOnTarget(`rm -rf -- ${quoteForRemoteShell(remoteHome)}`).catch(() => undefined);
  }
});

/** Started at load because `skipIf` below is decided at collection time. */
const fixture = await startSshFixtureIfRequested(process.env, afterAll);
const canReachLocalhost = fixture !== undefined || (await probeLocalhostSsh());
const config: SshEnvironmentConfig = sshTargetFor(fixture);

/** One script on the target through the hub's real ssh command runner. */
function runOnTarget(script: string, options?: RuntimeCommandOptions) {
  return sshCommandRunnerFor(fixture, config)(script, options);
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-ssh-push-'));
  const path = join(workdir, 'mangostudio-runtime');
  await writeFile(path, `#!/bin/sh\necho "dev"\n`);
  await chmod(path, 0o755);
  fakeBinary = new Uint8Array(await Bun.file(path).arrayBuffer());

  if (!canReachLocalhost) return;

  const homeResult = await runOnTarget('mktemp -d /tmp/mango-ssh-push-XXXXXX');
  if (homeResult.exitCode !== 0) {
    throw new Error(`Could not create isolated remote HOME: ${homeResult.stderr}`);
  }
  remoteHome = homeResult.stdout.trim();
  isolatedRunner = (script: string, options?: RuntimeCommandOptions) =>
    runOnTarget(`export HOME=${quoteForRemoteShell(remoteHome)}; ${script}`, options);
});

describe('ssh runtime push over a real sshd', () => {
  it.skipIf(!canReachLocalhost)('probes platform and pushes idempotently by digest', async () => {
    if (!isolatedRunner) throw new Error('expected isolated runner');
    const runner = isolatedRunner;
    const probe = await runner(PLATFORM_PROBE_SCRIPT);
    expect(probe.exitCode).toBe(0);
    // The same parser the push itself uses, against a real host's output —
    // a private reading here would stop testing what production does.
    const parsed = parsePlatformProbe(probe.stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(resolveRuntimePlatformId(parsed)).toBeTruthy();

    await pushRuntimeBinary({
      runner,
      slot: 'remote',
      version: 'dev',
      bytes: fakeBinary,
      timeoutMs: 60_000,
    });
    // Second push with the same bytes should still succeed (overwrite + version check).
    await pushRuntimeBinary({
      runner,
      slot: 'remote',
      version: 'dev',
      bytes: fakeBinary,
      timeoutMs: 60_000,
    });
  });

  // Runs everywhere: cancellation is a property of the push helper, not of
  // sshd, and asserting `controller.signal.aborted` after calling `abort()`
  // would test AbortController rather than anything this repo ships.
  it('refuses to run a single command once the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const runner: RuntimeCommandRunner = (script) => {
      calls.push(script);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };

    await expect(
      pushRuntimeBinary({
        runner,
        slot: 'remote',
        version: 'dev',
        bytes: fakeBinary,
        signal: controller.signal,
      })
    ).rejects.toThrow(/cancelled/);
    expect(calls).toEqual([]);
  });

  it.skipIf(!canReachLocalhost)('kills an in-flight transfer when the signal aborts', async () => {
    if (!isolatedRunner) throw new Error('expected isolated runner');
    const controller = new AbortController();
    // Abort once the first chunk is on the wire, so the kill lands mid-write
    // rather than on the pre-flight check the test above covers.
    const push = pushRuntimeBinary({
      runner: isolatedRunner,
      slot: 'remote',
      version: 'dev',
      bytes: fakeBinary,
      timeoutMs: 60_000,
      signal: controller.signal,
      onStdinProgress: () => controller.abort(),
    });

    await expect(push).rejects.toThrow();
  });
});
