import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeSshClient } from '../../../src/cli/ssh-client-probe';

describe('probeSshClient', () => {
  it('reports a missing client without inventing a version', async () => {
    expect(await probeSshClient(null)).toEqual({ path: null, version: null, error: null });
  });

  it('rejects a nonzero ssh -V even when stderr has text', async () => {
    // A wrong binary on PATH can print an error and still leave a line for the
    // old "any stderr is a version" path to misread as success.
    const path = await writeFailingSsh('ssh: unsupported option', 1);
    try {
      const probe = await probeSshClient(path);
      expect(probe.version).toBeNull();
      expect(probe.error).toContain('unsupported option');
    } finally {
      await rm(dirname(path), { force: true, recursive: true });
    }
  });

  it('accepts a real OpenSSH banner when present', async () => {
    const path = Bun.which('ssh');
    if (!path) return;
    const probe = await probeSshClient(path);
    expect(probe.error).toBeNull();
    expect(probe.version).toMatch(/OpenSSH/i);
  });
});

/**
 * A stand-in `ssh` that prints `stderrText` on stderr and exits with
 * `exitCode`, whatever it is asked. POSIX gets a `#!/bin/sh` script; Windows
 * cannot execute a shebang, so it gets an `ssh.cmd` batch file, which
 * `Bun.spawn` starts through cmd.exe.
 */
async function writeFailingSsh(stderrText: string, exitCode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mango-ssh-probe-'));
  if (process.platform === 'win32') {
    const path = join(directory, 'ssh.cmd');
    await writeFile(
      path,
      ['@echo off', `1>&2 echo ${stderrText}`, `exit /b ${exitCode}`, ''].join('\r\n')
    );
    return path;
  }
  const path = join(directory, 'ssh');
  await writeFile(path, `#!/bin/sh\necho "${stderrText}" >&2\nexit ${exitCode}\n`);
  await chmod(path, 0o755);
  return path;
}
