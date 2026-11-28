// The rust-cache composite's two scripts, run as shipped (the `run:` text of the `prune` and
// `profile` steps) the way cache-policy.unit.test.ts runs cache-scoped's. `prune` runs against a
// named fake rustup that keeps its toolchain list in a file; `profile` runs against throwaway
// manifests. Where the composite is wired into workflows is pinned in cache-policy.unit.test.ts.
import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCompositeStep, type StepResult } from './support/cache-scoped-steps';
import { readText } from './support/read-text';
import { useScratchDirs } from './support/scratch-dirs';

const ACTION = '.github/actions/rust-cache/action.yml';
const FAKE_RUSTUP = 'scripts/tests/support/fake-rustup-toolchains.bash';
const PINNED = '1.100.0-x86_64-unknown-linux-gnu';
const IMAGE_STABLE = 'stable-x86_64-unknown-linux-gnu';
const FUZZ_NIGHTLY = 'nightly-2026-11-14-x86_64-unknown-linux-gnu';

const makeDir = useScratchDirs();

interface PruneRun {
  readonly result: StepResult;
  /** One entry per rustup call, in order. */
  readonly calls: readonly string[];
  /** The toolchains rustup reports after the step. */
  readonly remaining: readonly string[];
}

/** Run `prune` on a machine whose rustup lists `installed`, keeping `keep` besides the pinned one. */
async function prune(
  installed: readonly string[],
  keep = '',
  fakeEnv: Record<string, string> = {}
): Promise<PruneRun> {
  const dir = makeDir('mango-prune-toolchains-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  copyFileSync(join(import.meta.dir, '..', '..', FAKE_RUSTUP), join(bin, 'rustup'));
  chmodSync(join(bin, 'rustup'), 0o755);
  const state = join(dir, 'toolchains');
  const log = join(dir, 'rustup.log');
  writeFileSync(state, installed.map((name) => `${name}\n`).join(''));
  writeFileSync(log, '');

  const result = await runCompositeStep(
    'prune',
    {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      FAKE_RUSTUP_LOG: log,
      FAKE_RUSTUP_STATE: state,
      FAKE_RUSTUP_PINNED: PINNED,
      KEEP_TOOLCHAINS: keep,
      ...fakeEnv,
    },
    dir,
    ACTION
  );
  const lines = (path: string) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  return { result, calls: lines(log), remaining: lines(state) };
}

function uninstallCalls(run: PruneRun): string[] {
  return run.calls.filter((call) => call.startsWith('toolchain uninstall'));
}

describe('rust-cache action: toolchain pruning', () => {
  test("uninstalls the image's stable and installs the pinned toolchain when it is missing", async () => {
    const run = await prune([IMAGE_STABLE]);
    expect(run.result.exitCode, run.result.stderr).toBe(0);
    expect(run.remaining, 'expected only the pinned toolchain left').toEqual([PINNED]);
    expect(run.calls).toContain('toolchain install');
    expect(run.calls).toContain(`default ${PINNED}`);
    expect(uninstallCalls(run)).toEqual([`toolchain uninstall ${IMAGE_STABLE}`]);
  });

  test('keeps the pinned toolchain and the named ones, matched by release prefix', async () => {
    const run = await prune(
      [IMAGE_STABLE, PINNED, FUZZ_NIGHTLY, 'beta-x86_64-unknown-linux-gnu'],
      'nightly-2026-11-14'
    );
    expect(run.result.exitCode, run.result.stderr).toBe(0);
    expect(run.remaining).toEqual([PINNED, FUZZ_NIGHTLY]);
    expect(uninstallCalls(run)).toEqual([
      `toolchain uninstall ${IMAGE_STABLE} beta-x86_64-unknown-linux-gnu`,
    ]);
  });

  test('a prefix must end at the release: 1.9 never names 1.98.0', async () => {
    const run = await prune([IMAGE_STABLE, PINNED, '1.98.0-x86_64-unknown-linux-gnu'], '1.9');
    expect(run.result.exitCode, 'expected a refusal for the toolchain nobody installed').toBe(1);
    expect(run.result.stderr).toContain('expected toolchain 1.9 installed before pruning');
    expect(run.result.stderr).toContain(`received: ${IMAGE_STABLE} ${PINNED}`);
    expect(run.remaining, 'nothing may be removed after a refusal').toEqual([
      IMAGE_STABLE,
      PINNED,
      '1.98.0-x86_64-unknown-linux-gnu',
    ]);
    expect(uninstallCalls(run)).toEqual([]);
    expect(run.calls.filter((call) => call.startsWith('default'))).toEqual([]);
  });

  test('makes no uninstall call when nothing is surplus', async () => {
    const run = await prune([PINNED]);
    expect(run.result.exitCode, run.result.stderr).toBe(0);
    expect(uninstallCalls(run), 'rustup refuses an uninstall with no name').toEqual([]);
    expect(run.result.stdout).toContain(`toolchains: ${PINNED}`);
  });

  test('stops before removing anything when rustup names no active toolchain', async () => {
    const run = await prune([IMAGE_STABLE], '', { FAKE_RUSTUP_NO_ACTIVE: '1' });
    expect(run.result.exitCode).not.toBe(0);
    expect(run.result.stderr).toContain('no active toolchain');
    expect(uninstallCalls(run)).toEqual([]);
    // The install call ran first, so the image's stable is still there beside the pin.
    expect(run.remaining).toEqual([IMAGE_STABLE, PINNED]);
  });

  test('reads rustup output that ends its lines with CRLF, as on Windows', async () => {
    const run = await prune([IMAGE_STABLE, PINNED], '', { FAKE_RUSTUP_CRLF: '1' });
    expect(run.result.exitCode, run.result.stderr).toBe(0);
    // The fake refuses a name that still carries the carriage return.
    expect(uninstallCalls(run)).toEqual([`toolchain uninstall ${IMAGE_STABLE}`]);
    expect(run.remaining).toEqual([PINNED]);
  });
});

/** A root manifest shaped like this repository's: workspace, dependencies, profiles. */
function manifest(overrides: { rustVersion?: string; edit?: (text: string) => string } = {}) {
  const base = [
    '[workspace]',
    'members = ["crates/a", "crates/b"]',
    'resolver = "3"',
    '',
    '[workspace.package]',
    'version = "1.2.0"',
    `rust-version = "${overrides.rustVersion ?? '1.100.0'}"`,
    '',
    '[workspace.dependencies]',
    'serde = "1.0.200"',
    '',
    '# Release builds are size-tuned.',
    '[profile.release]',
    'lto = "fat"',
    '  codegen-units = 1',
    '',
    '[profile.release.package.regex-syntax]',
    'opt-level = "s"',
    '',
  ].join('\n');
  return overrides.edit ? overrides.edit(base) : base;
}

async function profileRun(text: string, path = 'Cargo.toml'): Promise<StepResult> {
  const dir = makeDir('mango-profile-digest-');
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
  return runCompositeStep('profile', { PROFILE_MANIFEST: path }, dir, ACTION);
}

async function digestOf(text: string): Promise<string> {
  const run = await profileRun(text);
  expect(run.exitCode, run.stderr).toBe(0);
  const digest = run.outputs.digest;
  expect(digest, `expected a 64-hex digest output | received: ${digest}`).toMatch(/^[a-f0-9]{64}$/);
  return digest;
}

describe('rust-cache action: profile digest', () => {
  test('a profile edit changes it', async () => {
    const before = await digestOf(manifest());
    expect(
      await digestOf(manifest({ edit: (t) => t.replace('lto = "fat"', 'lto = "thin"') }))
    ).not.toBe(before);
    expect(
      await digestOf(manifest({ edit: (t) => t.replace('opt-level = "s"', 'opt-level = 3') })),
      'a per-package profile table is a profile edit'
    ).not.toBe(before);
    expect(
      await digestOf(manifest({ edit: (t) => `${t}\n[profile.dev]\ndebug = 0\n` })),
      'a new profile table is a profile edit'
    ).not.toBe(before);
  });

  test('a rust-version change changes it', async () => {
    expect(await digestOf(manifest({ rustVersion: '1.101.0' }))).not.toBe(
      await digestOf(manifest())
    );
  });

  test('a [workspace.dependencies] edit does not', async () => {
    const before = await digestOf(manifest());
    const bumped = manifest({
      edit: (t) =>
        t.replace(
          'serde = "1.0.200"',
          'serde = "1.0.230"\ntokio = { version = "1", features = ["rt"] }'
        ),
    });
    expect(await digestOf(bumped)).toBe(before);
  });

  test('a comment, blank-line or spacing edit outside the profiles does not', async () => {
    const before = await digestOf(manifest());
    const edited = manifest({
      edit: (t) =>
        `# A new header comment.\n\n${t.replace('resolver = "3"', '# why 3\nresolver = "3"\n\n')}`,
    });
    expect(await digestOf(edited)).toBe(before);
  });

  test('a comment inside a profile and indentation do not either', async () => {
    const before = await digestOf(manifest());
    const edited = manifest({
      edit: (t) =>
        t
          .replace('lto = "fat"', '# fat LTO is the shipping setting\nlto = "fat"')
          .replace('  codegen-units = 1', 'codegen-units = 1'),
    });
    expect(await digestOf(edited)).toBe(before);
  });

  test('a trailing comment on a profile line, a header or rust-version does not change it', async () => {
    const before = await digestOf(manifest());
    const edited = manifest({
      edit: (t) =>
        t
          .replace('lto = "fat"', 'lto = "fat" # a note')
          .replace('[profile.release]', '[profile.release] # shipping')
          .replace('rust-version = "1.100.0"', 'rust-version = "1.100.0" # msrv'),
    });
    expect(await digestOf(edited)).toBe(before);
    expect(
      await digestOf(manifest({ edit: (t) => t.replace('lto = "fat"', 'lto = "fat" # other') })),
      'a different comment text'
    ).toBe(before);
  });

  test('spacing around the first = does not change it', async () => {
    const before = await digestOf(manifest());
    const edited = manifest({
      edit: (t) =>
        t
          .replace('lto = "fat"', 'lto="fat"')
          .replace('opt-level = "s"', '  opt-level   =   "s"  ')
          .replace('rust-version = "1.100.0"', 'rust-version="1.100.0"')
          .replace(
            '[profile.release.package.regex-syntax]',
            '[ profile.release.package.regex-syntax ]'
          ),
    });
    expect(await digestOf(edited)).toBe(before);
  });

  test('a # or = inside a quoted value is part of the value', async () => {
    const withValue = (value: string, quote = '"') =>
      manifest({
        edit: (t) => t.replace('lto = "fat"', `lto = "fat"\nnote = ${quote}${value}${quote}`),
      });
    const before = await digestOf(withValue('a # b = c'));
    expect(await digestOf(withValue('a # d = c')), 'text after a quoted # still counts').not.toBe(
      before
    );
    expect(await digestOf(withValue('a # b = d')), 'text after a quoted = still counts').not.toBe(
      before
    );
    expect(await digestOf(withValue('a # b = c', "'")), 'a TOML literal string').not.toBe(
      await digestOf(withValue('a # d = c', "'"))
    );
    expect(
      await digestOf(
        manifest({ edit: (t) => t.replace('lto = "fat"', 'lto = "fat"\nnote = "say \\" # hi"') })
      ),
      'a # after an escaped quote is still inside the string'
    ).not.toBe(
      await digestOf(
        manifest({ edit: (t) => t.replace('lto = "fat"', 'lto = "fat"\nnote = "say \\" # ho"') })
      )
    );
  });

  test('a member list or workspace version edit does not', async () => {
    const before = await digestOf(manifest());
    const edited = manifest({
      edit: (t) =>
        t
          .replace(
            'members = ["crates/a", "crates/b"]',
            'members = ["crates/a", "crates/b", "crates/c"]'
          )
          .replace('version = "1.2.0"', 'version = "1.3.0"'),
    });
    expect(await digestOf(edited)).toBe(before);
  });

  test('a CRLF checkout of the same manifest hashes the same', async () => {
    const lf = manifest();
    expect(await digestOf(lf.replace(/\n/g, '\r\n'))).toBe(await digestOf(lf));
  });

  test('a manifest without a rust-version still hashes its profiles (the fuzz workspace)', async () => {
    const fuzz = '[package]\nname = "fuzz"\n\n[profile.release]\ndebug = 1\n';
    const run = await profileRun(fuzz, 'crates/fuzz/Cargo.toml');
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.outputs.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('a missing manifest fails naming the path it looked for', async () => {
    const dir = makeDir('mango-profile-digest-');
    const run = await runCompositeStep(
      'profile',
      { PROFILE_MANIFEST: 'crates/gone/Cargo.toml' },
      dir,
      ACTION
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('expected a Cargo manifest at crates/gone/Cargo.toml');
    expect(run.stderr).toContain('received: no such file');
  });

  test('a manifest with neither profiles nor rust-version fails instead of hashing nothing', async () => {
    const run = await profileRun('[workspace]\nmembers = []\n');
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      'expected [profile.*] tables or a rust-version in Cargo.toml | received: neither'
    );
  });

  test("the repository's own root manifest yields a digest", async () => {
    const run = await profileRun(readText('Cargo.toml'));
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.outputs.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
