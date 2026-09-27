import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStagedFiles, getWorkingTreeChanges, resolveMergeBase } from '../lib/git';

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
  run(dir, 'init', '--quiet', '--initial-branch=main');
  for (const file of files) writeFileSync(join(dir, file), 'contents\n');
  commitAll(dir, 'seed');
  return dir;
}

function run(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: dir });
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitAll(dir: string, message: string): void {
  run(dir, 'add', '--all');
  run(
    dir,
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
    message
  );
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

describe('getWorkingTreeChanges', () => {
  // `bun test --changed=<ref>` selects from committed, staged, unstaged and
  // untracked changes alike; the planner has to see the same set, or it runs a
  // lane under --changed that a file Bun counts should have run whole.
  it('reports committed, staged, unstaged and untracked changes since the base', () => {
    const dir = repoWith(['committed.ts', 'staged.ts', 'unstaged.ts']);
    try {
      const base = run(dir, 'rev-parse', 'HEAD');
      writeFileSync(join(dir, 'committed.ts'), 'changed\n');
      commitAll(dir, 'second');
      writeFileSync(join(dir, 'staged.ts'), 'changed\n');
      run(dir, 'add', 'staged.ts');
      writeFileSync(join(dir, 'unstaged.ts'), 'changed\n');
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'nested', 'untracked.md'), 'new\n');

      expect(getWorkingTreeChanges(base, dir).sort()).toEqual([
        'committed.ts',
        'nested/untracked.md',
        'staged.ts',
        'unstaged.ts',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Paths are matched against `apps/<workspace>/` prefixes, so an untracked
  // file must come back repository-relative even when git runs from below the
  // root.
  it('reports untracked files repository-relative from a subdirectory', () => {
    const dir = repoWith(['kept.ts']);
    try {
      mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
      writeFileSync(join(dir, 'apps', 'api', 'new.ts'), 'new\n');
      writeFileSync(join(dir, 'top.ts'), 'new\n');

      expect(getWorkingTreeChanges('HEAD', join(dir, 'apps', 'api')).sort()).toEqual([
        'apps/api/new.ts',
        'top.ts',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing for a clean tree at the base', () => {
    const dir = repoWith(['kept.ts']);
    try {
      expect(getWorkingTreeChanges('HEAD', dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveMergeBase', () => {
  // Bun diffs `--changed=<ref>` against the ref itself, so a base branch that
  // moved on would drag its own commits into the selection.
  it('returns the fork point, not the tip of a base that moved on', () => {
    const dir = repoWith(['kept.ts']);
    try {
      const forkPoint = run(dir, 'rev-parse', 'HEAD');
      run(dir, 'checkout', '--quiet', '-b', 'feature');
      writeFileSync(join(dir, 'feature.ts'), 'feature\n');
      commitAll(dir, 'feature');
      run(dir, 'checkout', '--quiet', 'main');
      writeFileSync(join(dir, 'kept.ts'), 'main moved\n');
      commitAll(dir, 'main moves');
      run(dir, 'checkout', '--quiet', 'feature');

      expect(resolveMergeBase('main', dir)).toBe(forkPoint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the ref in the error when it does not resolve', () => {
    const dir = repoWith(['kept.ts']);
    try {
      expect(() => resolveMergeBase('no-such-ref', dir)).toThrow(/no-such-ref/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
