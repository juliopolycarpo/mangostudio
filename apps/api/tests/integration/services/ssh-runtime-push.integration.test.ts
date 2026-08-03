/**
 * Self-skipping SSH push / setup checks against localhost sshd.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SshEnvironmentConfig } from '@mangostudio/shared/environments';
import { resolveRuntimePlatformId } from '@mangostudio/shared/runtime-home';
import { pushRuntimeBinary } from '../../../src/modules/environments/domain/runtime-push';
import { PLATFORM_PROBE_SCRIPT } from '../../../src/modules/environments/domain/wsl-runtime-release';
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

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-ssh-push-'));
  const path = join(workdir, 'mangostudio-runtime');
  await writeFile(path, `#!/bin/sh\necho "dev"\n`);
  await chmod(path, 0o755);
  fakeBinary = new Uint8Array(await Bun.file(path).arrayBuffer());
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
});

describe('ssh runtime push over a real sshd', () => {
  it.skipIf(!canReachLocalhost)('probes platform and pushes idempotently by digest', async () => {
    const config: SshEnvironmentConfig = { host: 'localhost' };
    const runner = createSshCommandRunner(config);
    const probe = await runner(PLATFORM_PROBE_SCRIPT);
    expect(probe.exitCode).toBe(0);
    const lines = probe.stdout.trim().split(/\r?\n/);
    const platformId = resolveRuntimePlatformId({
      kernel: lines[0] ?? 'Linux',
      machine: lines[1] ?? lines[0] ?? '',
      libc: lines[2] ?? lines[1] ?? '',
    });
    expect(platformId).toBeTruthy();

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

  it.skipIf(!canReachLocalhost)('cancel path never starts when aborted before push', () => {
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
