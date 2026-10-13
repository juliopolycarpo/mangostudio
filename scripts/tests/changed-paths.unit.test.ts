import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { decodeChangedPaths } from '../lib/changed-paths';
import { distributionRelevant, releaseRelevance } from '../lib/ci-lanes';
import { ROOT_DIR } from '../lib/config';
import { touchesProtocolSurface } from '../lib/protocol';
import { classifyChangedPaths, RUST_WORKSPACE_PATHS } from '../lib/rust-lanes';
import baseline from './support/lane-baseline.json';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

const encode = (paths: readonly string[]) => new TextEncoder().encode(`${paths.join('\0')}\0`);
const root = mkdtempSync(join(tmpdir(), 'ci-paths-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

function write(path: string, text = 'test\n'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function cli(script: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, join(ROOT_DIR, 'scripts/ci', script), ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

git('init', '--quiet');
git('config', 'user.email', 'ci-path-test@example.invalid');
git('config', 'user.name', 'CI path test');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.quotePath', 'true');
write('README.md');
write('crates/mangostudio-runtime/src/rename.rs');
write('docs/protocol/rename.md');
git('add', '--all');
git('commit', '--quiet', '-m', 'fixture base');
const base = git('rev-parse', 'HEAD').trim();
const unusual = [
  'crates/mangostudio-runtime/src/café.rs',
  'crates/mangostudio-runtime/src/tab\tname.rs',
  'crates/mangostudio-runtime/src/line\nbreak.rs',
  'crates/mangostudio-runtime/src/ spaced .rs',
  'spec/fixtures/1/line\nbreak.json',
  'spec/fixtures/1/café.json',
  ' Cargo.toml',
  'Cargo.toml ',
  ' ',
  '\ufeffCargo.toml',
];
// Windows cannot create control-character or trailing-space names. The NUL
// decoder test below still exercises the complete literal set on every OS.
const fixtureNames = unusual.filter(
  (path) => process.platform !== 'win32' || (!/[\t\n]/.test(path) && !path.endsWith(' '))
);
for (const path of fixtureNames) write(path);
renameSync(join(root, 'crates/mangostudio-runtime/src/rename.rs'), join(root, 'docs/renamed.md'));
write('crates/mango-protocol/renamed.rs');
renameSync(join(root, 'docs/protocol/rename.md'), join(root, 'crates/mango-protocol/renamed.rs'));
git('add', '--all');
git('commit', '--quiet', '-m', 'fixture unusual paths and renames');
const head = git('rev-parse', 'HEAD').trim();
const pathsFile = join(root, 'paths.nul');

describe('literal Git path transport', () => {
  test('reproduces the Unicode quoted-name miss in the former newline collector', () => {
    const old = git('diff', '--no-renames', '--name-only', base, head);
    const quoted = old.split('\n').find((path) => path.includes('caf') && path.includes('runtime'));
    expect(quoted).toStartWith('"crates/');
    expect(classifyChangedPaths([quoted as string])).toEqual({ rust: false, qualification: false });
    expect(classifyChangedPaths([unusual[0] as string])).toEqual({
      rust: true,
      qualification: true,
    });
  });

  test('collects Unicode, whitespace, control characters and both sides of renames exactly', () => {
    const collect = cli('changed-paths.ts', 'collect', base, head, pathsFile);
    expect(collect.exitCode, collect.stderr.toString()).toBe(0);
    const paths = decodeChangedPaths(readFileSync(pathsFile));
    expect(paths.sort()).toEqual(
      [
        ...fixtureNames,
        'crates/mangostudio-runtime/src/rename.rs',
        'docs/renamed.md',
        'docs/protocol/rename.md',
        'crates/mango-protocol/renamed.rs',
      ].sort()
    );
    expect(cli('rust-lanes.ts', 'relevance', pathsFile).stdout.toString()).toBe(
      'rust=true\nqualification=true\n'
    );
    expect(cli('protocol-lanes.ts', 'relevance', pathsFile).stdout.toString()).toBe(
      'protocol=true\n'
    );
    expect(cli('changed-paths.ts', 'release', pathsFile).stdout.toString()).toBe(
      'release=true\nlauncher=false\n'
    );
  });

  test('the NUL decoder retains the complete literal set on every host OS', () => {
    expect(decodeChangedPaths(encode(unusual))).toEqual(unusual);
  });

  test('literal whitespace and a Unicode BOM cannot turn an unrelated path into a compiler pin', () => {
    for (const path of [' Cargo.toml', 'Cargo.toml ', '\ufeffCargo.toml', ' ']) {
      expect(decodeChangedPaths(encode([path]))).toEqual([path]);
      expect(classifyChangedPaths([path])).toEqual({ rust: false, qualification: false });
      expect(touchesProtocolSurface([path])).toBe(false);
    }
  });

  test.each([
    new Uint8Array(),
    encode(['']),
    encode(['a', '']),
    new TextEncoder().encode('Cargo.toml\n'),
    encode(['/Cargo.toml']),
    encode(['../Cargo.toml']),
    encode(['a/./b']),
    encode(['a//b']),
    new Uint8Array([0xff, 0]),
  ])('invalid or empty input fails before any CLI can emit a skip: %p', (bytes) => {
    const invalid = join(root, 'invalid.nul');
    writeFileSync(invalid, bytes);
    for (const [script, command] of [
      ['rust-lanes.ts', 'relevance'],
      ['protocol-lanes.ts', 'relevance'],
      ['changed-paths.ts', 'distribution'],
      ['changed-paths.ts', 'release'],
    ]) {
      const run = cli(script as string, command as string, invalid);
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout.toString()).toBe('');
    }
  });

  test('missing arguments/files, invalid revisions, failed diffs and empty diffs fail closed', () => {
    for (const [script, args] of [
      ['rust-lanes.ts', ['relevance']],
      ['protocol-lanes.ts', ['relevance']],
      ['changed-paths.ts', ['distribution']],
      ['changed-paths.ts', ['release', join(root, 'missing')]],
      ['changed-paths.ts', ['collect', '--name-only', head, pathsFile]],
      ['changed-paths.ts', ['collect', 'f'.repeat(40), head, pathsFile]],
      ['changed-paths.ts', ['collect', head, head, pathsFile]],
    ] as const) {
      const run = cli(script, ...args);
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout.toString()).toBe('');
    }
  });
});

describe('relevance policy parity', () => {
  test('all tracked paths retain every lane verdict with exact detector and reuse inputs', () => {
    const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT_DIR, stdout: 'pipe' });
    expect(tracked.exitCode).toBe(0);
    for (const path of decodeChangedPaths(tracked.stdout)) {
      expect(distributionRelevant([path]), path).toBe(
        !new RegExp(baseline.policies.distribution).test(path)
      );
      const sharedDetectorInputs = [
        'scripts/lib/changed-paths.ts',
        'scripts/lib/ci-lanes.ts',
        'scripts/ci/changed-paths.ts',
      ];
      expect(releaseRelevance([path]), path).toEqual({
        release:
          new RegExp(baseline.policies.release).test(path) ||
          path === 'scripts/ci/changed-paths.ts' ||
          path === 'scripts/ci/dry-run-artifacts.ts' ||
          path.startsWith('.github/actions/download-distribution/'),
        launcher:
          new RegExp(baseline.policies.launcher).test(path) || sharedDetectorInputs.includes(path),
      });
      expect(touchesProtocolSurface([path]), path).toBe(
        new RegExp(baseline.policies.protocol).test(path) ||
          [...sharedDetectorInputs, 'scripts/ci/protocol-lanes.ts'].includes(path)
      );
      const rustDetectorInputs = [
        ...sharedDetectorInputs,
        'scripts/lib/rust-lanes.ts',
        'scripts/ci/rust-lanes.ts',
      ];
      const matches = (globs: readonly string[]) =>
        globs.some((glob) => new Bun.Glob(glob).match(path));
      expect(classifyChangedPaths([path]), path).toEqual({
        rust: matches(baseline.rustPaths.workspace) || rustDetectorInputs.includes(path),
        qualification:
          matches(baseline.rustPaths.qualification) || rustDetectorInputs.includes(path),
      });
    }
  });

  test('narrow policies leave unknown paths alone while distribution runs', () => {
    const paths = ['unknown/path', 'Dockerfile.alpine', ' Cargo.toml'];
    expect(distributionRelevant(paths)).toBe(true);
    expect(classifyChangedPaths(paths)).toEqual({ rust: false, qualification: false });
    expect(touchesProtocolSurface(paths)).toBe(false);
    expect(releaseRelevance(paths)).toEqual({ release: false, launcher: false });
  });

  test('every Rust detector helper triggers both of the lanes it can suppress', () => {
    for (const path of RUST_WORKSPACE_PATHS.filter(
      (path) => path.includes('lanes.ts') || path.includes('changed-paths.ts')
    )) {
      expect(classifyChangedPaths([path]), path).toEqual({ rust: true, qualification: true });
    }
  });

  test.each(['ci', 'cargo-shim', 'protocol-ci', 'release-dry-run'])(
    '%s collects only PR diffs and preserves non-PR behavior',
    (name) => {
      const changes = extractJobBlock(readText(`.github/workflows/${name}.yml`), 'changes');
      const step = extractStepBlocks(changes).find((block) =>
        block.includes('changed-paths.ts collect')
      );
      expect(step).toBeDefined();
      expect(step).toContain('if [ "$EVENT_NAME" != "pull_request" ]; then');
      expect(step).toContain('exit 0');
      expect(step).not.toContain('git diff');
      expect(step).not.toContain('grep -Eq');
      const expected =
        name === 'ci'
          ? ['distribution']
          : name === 'cargo-shim'
            ? ['rust', 'qualification']
            : name === 'protocol-ci'
              ? ['protocol']
              : ['release', 'launcher'];
      for (const lane of expected) expect(step).toContain(`echo "${lane}=true"`);
    }
  );
});
