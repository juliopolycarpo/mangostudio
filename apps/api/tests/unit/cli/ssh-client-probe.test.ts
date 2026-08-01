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
    const path = await writeFakeSsh(['#!/bin/sh', 'echo "ssh: unsupported option" >&2', 'exit 1']);
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

async function writeFakeSsh(lines: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mango-ssh-probe-'));
  const path = join(directory, 'ssh');
  await writeFile(path, `${lines.join('\n')}\n`);
  await chmod(path, 0o755);
  return path;
}
