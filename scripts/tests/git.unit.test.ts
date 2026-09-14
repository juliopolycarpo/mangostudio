import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStagedFiles } from '../lib/git';

/**
 * A throwaway repository with one commit, so the index has something to delete
 * from.
 *
 * Identity and signing are passed per command rather than configured: the
 * fixture must not depend on — or be refused by — whatever the machine running
 * it commits as.
 */
function repoWith(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-git-'));
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: dir });
    if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  };
  run('init', '--quiet', '--initial-branch=main');
  for (const file of files) writeFileSync(join(dir, file), 'contents\n');
  run('add', '--all');
  run(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'seed'
  );
  return dir;
}

describe('getStagedFiles', () => {
  // A commit that only removes a generated artifact used to report "nothing to
  // check": the scoped gates saw an empty file list and every one of them was
  // skipped.
  it('reports a staged deletion', () => {
    const dir = repoWith(['kept.ts', 'removed.ts']);
    try {
      const removed = Bun.spawnSync(['git', 'rm', '--quiet', 'removed.ts'], { cwd: dir });
      expect(removed.success).toBe(true);

      expect(getStagedFiles(dir)).toEqual(['removed.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a staged addition', () => {
    const dir = repoWith(['kept.ts']);
    try {
      writeFileSync(join(dir, 'added.ts'), 'contents\n');
      const added = Bun.spawnSync(['git', 'add', 'added.ts'], { cwd: dir });
      expect(added.success).toBe(true);

      expect(getStagedFiles(dir)).toEqual(['added.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
