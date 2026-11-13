import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { decodeChangedPaths } from '../lib/changed-paths';
import { codeqlRustRelevant, distributionRelevant, releaseRelevance } from '../lib/ci-lanes';
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
write('scripts/moved.ts');
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
mkdirSync(join(root, 'scripts/tests'), { recursive: true });
renameSync(join(root, 'scripts/moved.ts'), join(root, 'scripts/tests/moved.unit.test.ts'));
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
        'scripts/moved.ts',
        'scripts/tests/moved.unit.test.ts',
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
    for (const path of [
      ' Cargo.toml',
      'Cargo.toml ',
      '\ufeffCargo.toml',
      ' ',
      'Cargo.toml\n',
      'Cargo.toml\r',
    ]) {
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

  test('invalid revisions identify the received values and expected SHA shape', () => {
    const run = cli('changed-paths.ts', 'collect', '--name-only', head, pathsFile);
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe('');
    expect(run.stderr.toString()).toContain('base="--name-only"');
    expect(run.stderr.toString()).toContain(`head="${head}"`);
    expect(run.stderr.toString()).toContain(
      'expected 40- or 64-character lowercase hex commit SHAs'
    );
  });
});

describe('relevance policy parity', () => {
  test('omits distribution for a standalone root test-only diff', () => {
    expect(distributionRelevant(['scripts/tests/benchmark-runtime-version.unit.test.ts'])).toBe(
      false
    );
  });

  test.each([
    'scripts/tests/install-ps1-layout.unit.test.ts',
    'scripts/tests/verify-release-tag.unit.test.ts',
    'scripts/tests/support/root.unit.test.ts',
    'scripts/tests/.unit.test.ts',
    'scripts/tests/root.unit.test.ts\n',
    'scripts/tests/unknown name.unit.test.ts',
    'scripts/tests/source-fixture.json',
    'apps/api/src/index.ts',
    'docs/README.md',
  ])('a root unit test mixed with %j selects distribution', (path) => {
    expect(distributionRelevant(['scripts/tests/root.unit.test.ts', path])).toBe(true);
  });

  test('a source-to-test rename retains the source-side deletion in the distribution decision', () => {
    const changed = git('diff', '--no-renames', '--name-only', '-z', base, head, '--', 'scripts');
    const paths = decodeChangedPaths(new TextEncoder().encode(changed));
    expect(paths).toEqual(['scripts/moved.ts', 'scripts/tests/moved.unit.test.ts']);
    expect(distributionRelevant(paths)).toBe(true);
  });

  test('a sparse distribution checkout omits exactly the supported standalone test files', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'distribution-source-'));
    const paths = [
      'scripts/tests/root.unit.test.ts',
      'scripts/tests/root_2.unit.test.ts',
      'scripts/tests/install-ps1-layout.unit.test.ts',
      'scripts/tests/verify-release-tag.unit.test.ts',
      'scripts/tests/support/child.unit.test.ts',
      'scripts/tests/café.unit.test.ts',
      'scripts/tests/Uppercase.unit.test.ts',
      'scripts/tests/.unit.test.ts',
      'scripts/tests/unknown name.unit.test.ts',
      'scripts/tests/source.unit.test.ts/kept.ts',
      'scripts/tests/source-fixture.json',
      'apps/api/src/index.ts',
    ];
    try {
      git('-C', fixture, 'init', '--quiet');
      for (const path of paths) {
        const target = join(fixture, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'fixture\n');
      }
      git('-C', fixture, 'add', '--all');
      git(
        '-C',
        fixture,
        '-c',
        'user.email=ci-path-test@example.invalid',
        '-c',
        'user.name=CI path test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'distribution fixture'
      );
      const action = readText('.github/actions/distribution-source/action.yml');
      expect(action).toContain(
        'git -c core.ignoreCase=false sparse-checkout set --no-cone --stdin'
      );
      const scope = Bun.spawnSync(
        ['git', '-c', 'core.ignoreCase=false', 'sparse-checkout', 'set', '--no-cone', '--stdin'],
        {
          cwd: fixture,
          stdin: readFileSync(join(ROOT_DIR, '.github/actions/distribution-source/patterns')),
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      expect(scope.exitCode, scope.stderr.toString()).toBe(0);
      expect(git('-C', fixture, 'status', '--porcelain')).toBe('');
      for (const path of paths) {
        expect(existsSync(join(fixture, path)), path).toBe(distributionRelevant([path]));
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test.each([
    ['build', 'build'],
    ['distribution-build', 'prepare'],
    ['distribution-build', 'runtime-version'],
    ['distribution-build', 'hub'],
    ['distribution-build', 'build'],
    ['runtime-build', 'runtime'],
    ['smoke-binary', 'binary'],
    ['smoke-container', 'container'],
    ['release-dry-run', 'dry-run-linux'],
    ['release-dry-run', 'dry-run-windows'],
    ['release-dry-run', 'dry-run-cargo'],
  ])('%s / %s scopes source immediately after checkout', (workflow, job) => {
    const steps = extractStepBlocks(
      extractJobBlock(readText(`.github/workflows/${workflow}.yml`), job)
    );
    const checkout = steps.findIndex((step) => step.includes('uses: actions/checkout@'));
    expect(checkout, `expected a source checkout in ${workflow} / ${job}`).toBeGreaterThanOrEqual(
      0
    );
    expect(
      steps[checkout + 1]?.trim().split(' # ', 1)[0],
      `expected a scoped checkout in ${workflow} / ${job}`
    ).toBe('- uses: ./.github/actions/distribution-source');
  });

  test.each([
    'crates/mangostudio-runtime/src/main.rs',
    'crates/mango-protocol/Cargo.toml',
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    '.cargo/config.toml',
    'scripts/tests/support/fixture.rs',
    '.github/workflows/codeql.yml',
    '.github/codeql/config.yml',
    'scripts/lib/ci-lanes.ts',
    'scripts/lib/changed-paths.ts',
    'scripts/ci/changed-paths.ts',
  ])('a change to %j selects the CodeQL Rust legs', (path) => {
    expect(codeqlRustRelevant([path]), path).toBe(true);
    expect(codeqlRustRelevant(['docs/guide.md', path]), `docs/guide.md + ${path}`).toBe(true);
  });

  test.each([
    'apps/api/src/index.ts',
    'apps/frontend/src/main.tsx',
    'docs/reference/ci.md',
    '.github/workflows/ci.yml',
    '.github/dependabot.yml',
    'bun.lock',
    'scripts/lib/rust-lanes.ts',
    'docs/crates/overview.md',
  ])('a change to %j alone skips the CodeQL Rust legs', (path) => {
    expect(codeqlRustRelevant([path]), path).toBe(false);
  });

  test('the CodeQL classifier refuses an empty or malformed diff instead of skipping a leg', () => {
    expect(() => codeqlRustRelevant([])).toThrow('changed-paths: empty diff');
    expect(() => codeqlRustRelevant(['../Cargo.toml'])).toThrow(
      'changed-paths: invalid repository-relative path: "../Cargo.toml"'
    );
  });

  test.each(['tsconfig.json', 'tsconfig.native-build.json'])(
    'a change to standalone compiler config %j selects the release dry run',
    (path) => {
      expect(distributionRelevant([path]), path).toBe(true);
      expect(releaseRelevance([path]), path).toEqual({ release: true, launcher: false });
    }
  );

  test('all tracked paths retain every lane verdict with exact detector and reuse inputs', () => {
    const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT_DIR, stdout: 'pipe' });
    expect(tracked.exitCode).toBe(0);
    for (const path of decodeChangedPaths(tracked.stdout)) {
      const standaloneRootTest =
        /^scripts\/tests\/[a-z0-9_-]+\.unit\.test\.ts$/.test(path) &&
        path !== 'scripts/tests/install-ps1-layout.unit.test.ts' &&
        path !== 'scripts/tests/verify-release-tag.unit.test.ts';
      expect(distributionRelevant([path]), path).toBe(
        !standaloneRootTest && !new RegExp(baseline.policies.distribution).test(path)
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
          path === 'tsconfig.json' ||
          path === 'tsconfig.native-build.json' ||
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

  test.each(['LICENSE\n', 'README.md\n', 'README.md\r'])(
    'a trailing line terminator cannot make %j a distribution exception',
    (path) => expect(distributionRelevant([path])).toBe(true)
  );

  test('every Rust detector helper triggers both of the lanes it can suppress', () => {
    for (const path of RUST_WORKSPACE_PATHS.filter(
      (path) => path.includes('lanes.ts') || path.includes('changed-paths.ts')
    )) {
      expect(classifyChangedPaths([path]), path).toEqual({ rust: true, qualification: true });
    }
  });

  test.each(['ci', 'cargo-shim', 'protocol-ci', 'release-dry-run'])(
    '%s collects relevant diffs and preserves full qualification dispatch',
    (name) => {
      const changes = extractJobBlock(readText(`.github/workflows/${name}.yml`), 'changes');
      const step = extractStepBlocks(changes).find((block) =>
        block.includes('changed-paths.ts collect')
      );
      expect(step).toBeDefined();
      if (name === 'protocol-ci') {
        expect(step).toContain('github.event.pull_request.base.sha || github.event.before');
        expect(step).toContain('github.event.pull_request.head.sha || github.sha');
        expect(step).toContain(
          'if [ "$EVENT_NAME" = "workflow_dispatch" ] || [ "$BASE_SHA" = "0000000000000000000000000000000000000000" ]; then'
        );
      } else {
        expect(step).toContain('if [ "$EVENT_NAME" != "pull_request" ]; then');
      }
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
