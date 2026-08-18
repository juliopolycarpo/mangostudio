/**
 * Self-skipping SSH push / setup checks against localhost sshd.
 *
 * Isolates the remote mango home under a temporary directory so the test never
 * overwrites the developer's real `remote` slot under ~/.mango.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';
import { quoteForRemoteShell } from '@mangostudio/shared/environments';
import {
  PLATFORM_PROBE_SCRIPT,
  parsePlatformProbe,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';
import {
  pushRuntimeBinary,
  type RuntimeCommandOptions,
  type RuntimeCommandRunner,
} from '../../../src/modules/environments/domain/runtime-push';
import { createSshCommandRunner } from '../../../src/modules/environments/infrastructure/ssh-command-runner';

const hasSshClient = Bun.which('ssh') !== null;
const canReachLocalhost = hasSshClient && (await probeLocalhost());

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

let workdir = '';
let fakeBinary = new Uint8Array();
let remoteHome = '';
let isolatedRunner: RuntimeCommandRunner | null = null;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-ssh-push-'));
  const path = join(workdir, 'mangostudio-runtime');
  await writeFile(path, `#!/bin/sh\necho "dev"\n`);
  await chmod(path, 0o755);
  fakeBinary = new Uint8Array(await Bun.file(path).arrayBuffer());

  if (!canReachLocalhost) return;

  const config: SshEnvironmentConfig = { host: 'localhost' };
  const base = createSshCommandRunner(config);
  const homeResult = await base('mktemp -d /tmp/mango-ssh-push-XXXXXX');
  if (homeResult.exitCode !== 0) {
    throw new Error(`Could not create isolated remote HOME: ${homeResult.stderr}`);
  }
  remoteHome = homeResult.stdout.trim();
  isolatedRunner = (script: string, options?: RuntimeCommandOptions) =>
    base(`export HOME=${quoteForRemoteShell(remoteHome)}; ${script}`, options);
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
  if (canReachLocalhost && remoteHome) {
    const config: SshEnvironmentConfig = { host: 'localhost' };
    const base = createSshCommandRunner(config);
    await base(`rm -rf -- ${quoteForRemoteShell(remoteHome)}`).catch(() => undefined);
  }
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
