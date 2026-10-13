import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listTrackedFiles } from './tracked-files';

describe('QA tracked-file inventory', () => {
  it('preserves Git-quoted Unicode, control bytes, quotes and whitespace as literal paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qa-tracked-paths-'));
    const paths = [
      'scripts/unicodé.ts',
      'scripts/tab\tname.ts',
      'scripts/line\nname.ts',
      'scripts/quote"name.ts',
      'scripts/ trailing space .ts',
    ];
    const run = async (cmd: readonly string[]) => {
      const child = Bun.spawn([...cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    };
    try {
      expect((await run(['git', 'init', '--quiet'])).exitCode).toBe(0);
      expect((await run(['git', 'config', 'core.quotepath', 'true'])).exitCode).toBe(0);
      for (const path of paths) await Bun.write(join(cwd, path), 'export const x = 1;\n');
      expect((await run(['git', 'add', '--', 'scripts'])).exitCode).toBe(0);
      // The previous newline reader did not recover literal paths from these records.
      const quoted = await run(['git', 'ls-files']);
      expect(quoted.stdout.split('\n').filter(Boolean).sort()).not.toEqual([...paths].sort());
      expect((await listTrackedFiles(run)).sort()).toEqual([...paths].sort());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps an empty inventory distinct from Git failure or truncated transport', async () => {
    expect(
      await listTrackedFiles(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }))
    ).toEqual([]);
    await expect(
      listTrackedFiles(() =>
        Promise.resolve({ stdout: '', stderr: 'fatal: not a repository', exitCode: 128 })
      )
    ).rejects.toThrow('git ls-files failed: fatal: not a repository');
    await expect(
      listTrackedFiles(() =>
        Promise.resolve({ stdout: 'scripts/example.ts', stderr: '', exitCode: 0 })
      )
    ).rejects.toThrow('incomplete path record');
  });
});
