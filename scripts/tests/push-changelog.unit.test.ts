import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaptureResult } from '../lib/exec';
import {
  type CommandRunner,
  directCommitMessage,
  fallbackBranchName,
  isProtectionRejection,
  landChangelog,
  parsePushChangelogArgs,
  pullRequestBody,
  pullRequestTitle,
} from '../release/push-changelog';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-changelog-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

// Isolated git: no host/user config so signing and hook policies never leak in.
const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

/** A git CommandRunner bound to `cwd`, returning the captured result (no throw). */
const gitRunner =
  (cwd: string): CommandRunner =>
  (args) => {
    const result = Bun.spawnSync({
      cmd: ['git', '-C', cwd, ...args],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return Promise.resolve({
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? 0,
    });
  };

/** A gh stub that records every invocation and replies per a lookup of the
 * subcommand. `pr list` defaults to "no open PR" so the create path runs. */
const ghStub = (
  overrides: Record<string, CaptureResult> = {}
): { run: CommandRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const ok = (stdout = ''): CaptureResult => ({ stdout, stderr: '', exitCode: 0 });
  const run: CommandRunner = (args) => {
    calls.push([...args]);
    const key = `${args[0]} ${args[1]}`;
    if (key in overrides) return Promise.resolve(overrides[key]);
    if (key === 'pr list') return Promise.resolve(ok('0\n'));
    return Promise.resolve(ok());
  };
  return { run, calls };
};

/** Seed a bare remote (with a main branch + CHANGELOG.md) and a work clone of
 * it. When `protectMain` is set, the remote rejects pushes to main like GitHub
 * branch protection does, leaving other branches pushable. */
const seedRepos = (protectMain = false): { remote: string; work: string } => {
  const dir = makeTempDir();
  const seedDir = join(dir, 'seed');
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');

  git(dir, 'init', '--initial-branch=main', 'seed');
  writeFileSync(join(seedDir, 'CHANGELOG.md'), '# Changelog\n\nInitial.\n');
  git(seedDir, 'config', 'user.name', 'seed');
  git(seedDir, 'config', 'user.email', 'seed@example.com');
  git(seedDir, 'config', 'commit.gpgsign', 'false');
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-m', 'seed changelog');
  git(dir, 'clone', '--bare', '--quiet', 'seed', 'remote.git');
  git(dir, 'clone', '--quiet', 'remote.git', 'work');

  if (protectMain) {
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read old new ref; do',
        '  if [ "$ref" = "refs/heads/main" ]; then',
        '    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." 1>&2',
        '    exit 1',
        '  fi',
        'done',
        'exit 0',
        '',
      ].join('\n')
    );
    chmodSync(hook, 0o755);
  }

  return { remote, work };
};

describe('parsePushChangelogArgs', () => {
  test('parses version and defaults the branch to main', () => {
    expect(parsePushChangelogArgs(['--version', '1.2.3'])).toEqual({
      version: '1.2.3',
      branch: 'main',
    });
  });

  test('strips a leading v and honors an explicit branch', () => {
    expect(parsePushChangelogArgs(['--version', 'v1.2.3', '--branch', 'release'])).toEqual({
      version: '1.2.3',
      branch: 'release',
    });
  });

  test('accepts prerelease versions', () => {
    expect(parsePushChangelogArgs(['--version', '0.0.0-dryrun']).version).toBe('0.0.0-dryrun');
  });

  test('rejects unknown flags, missing values, and unsafe versions', () => {
    expect(() => parsePushChangelogArgs(['--nope', 'x'])).toThrow(/Unknown argument/);
    expect(() => parsePushChangelogArgs(['--version'])).toThrow(/Missing value/);
    expect(() => parsePushChangelogArgs(['--branch', 'main'])).toThrow(/--version is required/);
    expect(() => parsePushChangelogArgs(['--version', '../evil'])).toThrow(/Invalid --version/);
    expect(() => parsePushChangelogArgs(['--version', '1.0; rm -rf'])).toThrow(/Invalid --version/);
  });
});

describe('message builders', () => {
  test('direct commit carries [skip ci]; the PR title does not', () => {
    expect(directCommitMessage('1.2.3')).toBe('docs(changelog): update for v1.2.3 [skip ci]');
    expect(pullRequestTitle('1.2.3')).toBe('docs(changelog): update for v1.2.3');
  });

  test('fallback branch and PR body reference the version', () => {
    expect(fallbackBranchName('1.2.3')).toBe('chore/changelog-v1.2.3');
    expect(pullRequestBody('1.2.3')).toContain('`v1.2.3`');
    expect(pullRequestBody('1.2.3')).toContain('branch protection');
  });
});

describe('isProtectionRejection', () => {
  test('matches branch-protection signals', () => {
    for (const message of [
      'remote: error: GH006: Protected branch update failed for refs/heads/main.',
      '! [remote rejected] main -> main (protected branch hook declined)',
      'remote: error: Changes must be made through a pull request.',
      'remote: error: Required status check "ci" is expected.',
      'remote: Pull request is required for this branch.',
    ]) {
      expect(isProtectionRejection(message)).toBe(true);
    }
  });

  test('ignores non-fast-forward and network errors so they keep retrying', () => {
    for (const message of [
      '! [rejected] main -> main (non-fast-forward)',
      'Updates were rejected because the remote contains work that you do not have. (fetch first)',
      'fatal: unable to access: Could not resolve host: github.com',
    ]) {
      expect(isProtectionRejection(message)).toBe(false);
    }
  });
});

describe('landChangelog', () => {
  test('no-ops when CHANGELOG.md is unchanged', async () => {
    const { work } = seedRepos();
    const gh = ghStub();

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      git: gitRunner(work),
      gh: gh.run,
    });

    expect(result).toBe('up-to-date');
    expect(gh.calls).toHaveLength(0);
  });

  test('direct-pushes the changelog commit when main is writable', async () => {
    const { remote, work } = seedRepos();
    const gh = ghStub();
    writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\nUpdated for 1.2.3.\n');

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      git: gitRunner(work),
      gh: gh.run,
    });

    expect(result).toBe('pushed');
    expect(gh.calls).toHaveLength(0);
    expect(git(remote, 'show', 'main:CHANGELOG.md')).toContain('Updated for 1.2.3');
    expect(git(remote, 'log', '-1', '--format=%an %s', 'main')).toBe(
      'github-actions[bot] docs(changelog): update for v1.2.3 [skip ci]\n'
    );
  });

  test('falls back to a bot PR when main is protected', async () => {
    const { remote, work } = seedRepos(true);
    const gh = ghStub();
    const mainBefore = git(remote, 'rev-parse', 'main');
    writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\nUpdated for 1.2.3.\n');

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      git: gitRunner(work),
      gh: gh.run,
    });

    expect(result).toBe('pull-request');
    // main is untouched; the change lands on the fallback branch instead.
    expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(remote, 'show', 'chore/changelog-v1.2.3:CHANGELOG.md')).toContain(
      'Updated for 1.2.3'
    );
    // The PR branch commit drops [skip ci] so required checks can run.
    expect(git(remote, 'log', '-1', '--format=%s', 'chore/changelog-v1.2.3')).toBe(
      'docs(changelog): update for v1.2.3\n'
    );

    const create = gh.calls.find((call) => call[0] === 'pr' && call[1] === 'create');
    expect(create).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'chore/changelog-v1.2.3',
      '--title',
      'docs(changelog): update for v1.2.3',
      '--body',
      pullRequestBody('1.2.3'),
    ]);
    expect(gh.calls).toContainEqual([
      'pr',
      'merge',
      'chore/changelog-v1.2.3',
      '--squash',
      '--auto',
    ]);
  });

  test('reuses an existing open PR instead of creating a duplicate', async () => {
    const { work } = seedRepos(true);
    const gh = ghStub({ 'pr list': { stdout: '1\n', stderr: '', exitCode: 0 } });
    writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\nUpdated for 1.2.3.\n');

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      git: gitRunner(work),
      gh: gh.run,
    });

    expect(result).toBe('pull-request');
    expect(gh.calls.some((call) => call[1] === 'create')).toBe(false);
    expect(gh.calls).toContainEqual([
      'pr',
      'merge',
      'chore/changelog-v1.2.3',
      '--squash',
      '--auto',
    ]);
  });

  test('still lands the PR when auto-merge is not allowed', async () => {
    const { remote, work } = seedRepos(true);
    const gh = ghStub({
      'pr merge': {
        stdout: '',
        stderr: 'auto-merge is not allowed for this repository',
        exitCode: 1,
      },
    });
    writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n\nUpdated for 1.2.3.\n');

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      git: gitRunner(work),
      gh: gh.run,
    });

    expect(result).toBe('pull-request');
    expect(git(remote, 'show', 'chore/changelog-v1.2.3:CHANGELOG.md')).toContain('1.2.3');
  });
});
