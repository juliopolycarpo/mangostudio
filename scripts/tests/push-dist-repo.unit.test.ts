import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGitHubAuthHeader,
  parseFileMappings,
  parsePushDistRepoArgs,
  pushDistRepo,
  syncFilesIntoClone,
} from '../release/push-dist-repo';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-dist-repo-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

// Isolated git runner for fixture setup/assertions: no host or user config so
// the test never inherits signing or hook policies from the machine.
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

/** Bare "remote" seeded with a README and a foreign formula that must survive pushes. */
const makeBareRemote = (): string => {
  const dir = makeTempDir();
  const seedDir = join(dir, 'seed');
  const bareDir = join(dir, 'remote.git');
  mkdirSync(join(seedDir, 'Formula'), { recursive: true });
  writeFileSync(join(seedDir, 'README.md'), '# tap\n');
  writeFileSync(join(seedDir, 'Formula', 'other.rb'), 'class Other < Formula\nend\n');
  git(dir, 'init', '--initial-branch=main', 'seed');
  git(seedDir, 'config', 'user.name', 'seed');
  git(seedDir, 'config', 'user.email', 'seed@example.com');
  git(seedDir, 'config', 'commit.gpgsign', 'false');
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-m', 'seed tap');
  git(dir, 'clone', '--bare', '--quiet', 'seed', 'remote.git');
  return bareDir;
};

describe('parseFileMappings', () => {
  test('splits local and repo paths on the first colon', () => {
    expect(parseFileMappings(['tap/Formula/mangostudio.rb:Formula/mangostudio.rb'])).toEqual([
      { localPath: 'tap/Formula/mangostudio.rb', repoPath: 'Formula/mangostudio.rb' },
    ]);
  });

  test('rejects empty mappings, missing parts, and unsafe repo paths', () => {
    expect(() => parseFileMappings([])).toThrow(/at least one --file/i);
    expect(() => parseFileMappings(['no-separator'])).toThrow(/Invalid --file mapping/);
    expect(() => parseFileMappings([':repo-only'])).toThrow(/Invalid --file mapping/);
    expect(() => parseFileMappings(['local-only:'])).toThrow(/Invalid --file mapping/);
    expect(() => parseFileMappings(['a:/etc/passwd'])).toThrow(/Unsafe repo path/);
    expect(() => parseFileMappings(['a:../escape'])).toThrow(/Unsafe repo path/);
  });
});

describe('parsePushDistRepoArgs', () => {
  test('parses required flags and repeated --file mappings', () => {
    const args = parsePushDistRepoArgs([
      '--repo',
      'juliopolycarpo/homebrew-tap',
      '--token-env',
      'DIST_REPOS_TOKEN',
      '--message',
      'mangostudio 0.1.0',
      '--file',
      'a:Formula/a.rb',
      '--file',
      'b:Formula/b.rb',
    ]);

    expect(args.repo).toBe('juliopolycarpo/homebrew-tap');
    expect(args.tokenEnv).toBe('DIST_REPOS_TOKEN');
    expect(args.message).toBe('mangostudio 0.1.0');
    expect(args.branch).toBeUndefined();
    expect(args.mappings).toHaveLength(2);
  });

  test('rejects unknown flags, missing values, and malformed repos', () => {
    expect(() => parsePushDistRepoArgs(['--nope', 'x'])).toThrow(/Unknown argument/);
    expect(() => parsePushDistRepoArgs(['--repo'])).toThrow(/Missing value/);
    expect(() => parsePushDistRepoArgs(['--repo', 'a/b', '--file', 'a:b'])).toThrow(/required/);
    expect(() =>
      parsePushDistRepoArgs([
        '--repo',
        'https://github.com/a/b',
        '--token-env',
        'T',
        '--message',
        'm',
        '--file',
        'a:b',
      ])
    ).toThrow(/Invalid --repo/);
  });
});

describe('buildGitHubAuthHeader', () => {
  test('encodes the token as the x-access-token basic credential', () => {
    expect(buildGitHubAuthHeader('tok')).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`
    );
  });
});

describe('syncFilesIntoClone', () => {
  test('copies new and changed files, skips identical ones', () => {
    const dir = makeTempDir();
    const cloneDir = join(dir, 'clone');
    mkdirSync(join(cloneDir, 'Formula'), { recursive: true });
    writeFileSync(join(dir, 'same.rb'), 'same');
    writeFileSync(join(dir, 'changed.rb'), 'after');
    writeFileSync(join(dir, 'new.rb'), 'new');
    writeFileSync(join(cloneDir, 'Formula', 'same.rb'), 'same');
    writeFileSync(join(cloneDir, 'Formula', 'changed.rb'), 'before');

    const changed = syncFilesIntoClone(
      [
        { localPath: join(dir, 'same.rb'), repoPath: 'Formula/same.rb' },
        { localPath: join(dir, 'changed.rb'), repoPath: 'Formula/changed.rb' },
        { localPath: join(dir, 'new.rb'), repoPath: 'Formula/new.rb' },
      ],
      cloneDir
    );

    expect(changed).toEqual(['Formula/changed.rb', 'Formula/new.rb']);
  });

  test('creates missing nested parent directories for new repo paths', () => {
    const dir = makeTempDir();
    const cloneDir = join(dir, 'clone');
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"version":"1"}');

    const changed = syncFilesIntoClone(
      [{ localPath: join(dir, 'manifest.json'), repoPath: 'bucket/nested/manifest.json' }],
      cloneDir
    );

    expect(changed).toEqual(['bucket/nested/manifest.json']);
    expect(readFileSync(join(cloneDir, 'bucket/nested/manifest.json'), 'utf8')).toBe(
      '{"version":"1"}'
    );
  });

  test('throws when a local file is missing', () => {
    const dir = makeTempDir();
    expect(() =>
      syncFilesIntoClone([{ localPath: join(dir, 'absent.rb'), repoPath: 'a.rb' }], dir)
    ).toThrow();
  });
});

describe('pushDistRepo', () => {
  test('pushes a bot commit with only the mapped file, then no-ops on re-run', async () => {
    const remote = makeBareRemote();
    const dir = makeTempDir();
    const formulaPath = join(dir, 'mangostudio.rb');
    writeFileSync(formulaPath, 'class Mangostudio < Formula\nend\n');
    const mappings = [{ localPath: formulaPath, repoPath: 'Formula/mangostudio.rb' }];

    const first = await pushDistRepo({
      remoteUrl: remote,
      message: 'mangostudio 0.1.0',
      mappings,
    });
    expect(first).toBe('pushed');
    expect(git(remote, 'show', 'HEAD:Formula/mangostudio.rb')).toContain('Mangostudio');
    expect(git(remote, 'show', 'HEAD:Formula/other.rb')).toContain('Other');
    expect(git(remote, 'log', '-1', '--format=%an %s')).toBe(
      'github-actions[bot] mangostudio 0.1.0\n'
    );

    const headAfterFirst = git(remote, 'rev-parse', 'HEAD');
    const second = await pushDistRepo({
      remoteUrl: remote,
      message: 'mangostudio 0.1.0',
      mappings,
    });
    expect(second).toBe('up-to-date');
    expect(git(remote, 'rev-parse', 'HEAD')).toBe(headAfterFirst);

    writeFileSync(formulaPath, 'class Mangostudio < Formula\n  # 0.2.0\nend\n');
    const third = await pushDistRepo({
      remoteUrl: remote,
      message: 'mangostudio 0.2.0',
      mappings,
    });
    expect(third).toBe('pushed');
    expect(git(remote, 'log', '-1', '--format=%s')).toBe('mangostudio 0.2.0\n');
  });
});
