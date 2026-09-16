import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import {
  PROTOCOL_CHANGELOG,
  PROTOCOL_CLIFF_CONFIG,
  PROTOCOL_IMPORT_TIP,
  PROTOCOL_PATHS,
  PROTOCOL_ROOT_FILES,
  PROTOCOL_TAG_PREFIX,
  protocolTag,
  protocolVersion,
  touchesProtocolSurface,
} from '../lib/protocol';
import { protocolCheckTasks, protocolTestTasks, selectLanes } from '../protocol/tasks';
import { readText } from './support/read-text';

// The protocol ships on its own version line from inside this repository. These
// tests pin the two things that silently break when it does not: the tag prefix
// that keeps its releases out of the application's `release.yml`, and the path
// set that decides which lanes a change runs.

describe('protocol release train', () => {
  test('tags are prefixed so the application release workflow never sees them', () => {
    // release.yml triggers on an anchored `v*.*.*`; `protocol-v0.2.1` cannot match it.
    expect(PROTOCOL_TAG_PREFIX).toBe('protocol-v');
    expect(protocolTag('0.2.1')).toBe('protocol-v0.2.1');
    expect(protocolTag('v0.2.1')).toBe('protocol-v0.2.1');
    expect(readText('.github/workflows/release.yml')).toContain('- "v*.*.*"');
  });

  test('protocolVersion is the inverse for a protocol tag and null for anything else', () => {
    expect(protocolVersion('protocol-v0.2.1')).toBe('0.2.1');
    expect(protocolVersion('protocol-v1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(protocolVersion('v0.2.1')).toBeNull();
  });

  test('the changelog and its git-cliff config sit beside the package', () => {
    expect(PROTOCOL_CHANGELOG).toBe('packages/protocol/CHANGELOG.md');
    expect(PROTOCOL_CLIFF_CONFIG).toBe('packages/protocol/cliff.toml');
    expect(Bun.file(PROTOCOL_CHANGELOG).size).toBeGreaterThan(0);
    expect(Bun.file(PROTOCOL_CLIFF_CONFIG).size).toBeGreaterThan(0);
  });
});

describe('touchesProtocolSurface', () => {
  test.each([
    'spec/schema/1/protocol.json',
    'packages/protocol/src/session.ts',
    'crates/mango-protocol/src/codec.rs',
    'crates/mango-protocol/fuzz/fuzz_targets/validate.rs',
    'docs/protocol/conformance.md',
    'scripts/protocol/check.ts',
    'Cargo.toml',
    'Cargo.lock',
    'deny.toml',
    'rustfmt.toml',
    'rust-toolchain.toml',
  ])('claims %s', (file) => {
    expect(touchesProtocolSurface([file])).toBe(true);
  });

  test.each([
    'apps/frontend/src/main.tsx',
    'package.json',
    'packages/cargo-shim/src/main.rs',
    'docs/architecture/overview.md',
    'scripts/check.ts',
  ])('leaves %s alone', (file) => {
    expect(touchesProtocolSurface([file])).toBe(false);
  });

  test('an empty change set touches nothing', () => {
    expect(touchesProtocolSurface([])).toBe(false);
  });

  test('every declared path and root file exists, so a rename cannot leave a dead rule', () => {
    // The same list drives the scoped-run predicate here and the CI path filter;
    // a directory renamed in one place and not the other fails open — no lane
    // runs, and nothing says so.
    for (const entry of [...PROTOCOL_PATHS, ...PROTOCOL_ROOT_FILES]) {
      expect(existsSync(join(ROOT_DIR, entry)), `${entry} is declared but does not exist`).toBe(
        true
      );
    }
    // Trailing slash matters: without it `spec` would also claim `special/`.
    expect(PROTOCOL_PATHS.every((prefix) => prefix.endsWith('/'))).toBe(true);
    expect(PROTOCOL_ROOT_FILES.every((file) => !file.endsWith('/'))).toBe(true);
  });
});

describe('selectLanes', () => {
  test('runs both halves by default, with formatting on', () => {
    expect(selectLanes([])).toEqual({ typescript: true, rust: true, format: true });
  });

  test('--ts-only and --rs-only each narrow to one half', () => {
    expect(selectLanes(['--ts-only'])).toEqual({
      typescript: true,
      rust: false,
      format: true,
    });
    expect(selectLanes(['--rs-only'])).toEqual({
      typescript: false,
      rust: true,
      format: true,
    });
  });

  test('--skip-format drops the formatter without changing the halves', () => {
    expect(selectLanes(['--skip-format'])).toEqual({
      typescript: true,
      rust: true,
      format: false,
    });
  });

  test('refuses both narrowing flags rather than resolving to nothing', () => {
    expect(() => selectLanes(['--ts-only', '--rs-only'])).toThrow(
      'Received both --ts-only and --rs-only; expected at most one, or neither to run both halves.'
    );
  });
});

describe('protocol lane selection', () => {
  const labels = (tasks: ReadonlyArray<{ label: string }>): string[] =>
    tasks.map((task) => task.label);

  test('--ts-only produces no cargo lane, whatever the machine has installed', () => {
    // This is what scripts/check.ts and scripts/test.ts pass: CI's Check job has
    // a 10-minute budget and GitHub's Linux runners ship a Rust toolchain, so a
    // lane gated only on `hasCargo()` would run the 25-minute half there.
    for (const label of labels(protocolCheckTasks(['--ts-only']))) {
      expect(label).not.toContain('clippy');
      expect(label).not.toContain('rustfmt');
      expect(label).not.toContain('powerset');
      expect(label).not.toContain('roundtrip');
    }
    for (const label of labels(protocolTestTasks(['--ts-only']))) {
      expect(label).not.toContain('cargo');
    }
  });

  test('the --ts-only check lane still typechecks, verifies the spec and the fixtures', () => {
    expect(labels(protocolCheckTasks(['--ts-only']))).toEqual([
      'protocol:workspace',
      'protocol:versions',
      'protocol:verify-spec',
      'protocol:schema-equality',
      'protocol:fixtures:chunks',
      'protocol:fixtures:ssh-argv',
      'protocol:fixtures:catalog-example',
    ]);
  });

  test('a narrowed schema-equality run is told so, rather than shelling out to cargo', () => {
    const equality = protocolCheckTasks(['--ts-only']).find(
      (task) => task.label === 'protocol:schema-equality'
    );
    expect(equality?.cmd).toContain('--ts-only');
  });

  test('--rs-only drops the TypeScript lanes and the cross-language round trip', () => {
    const cmds = labels(protocolCheckTasks(['--rs-only']));
    expect(cmds).not.toContain('protocol:workspace');
    expect(cmds).not.toContain('protocol:verify-spec');
    // The round trip drives the Rust decoder from the TypeScript encoder, so it
    // belongs to neither half alone.
    expect(cmds).not.toContain('protocol:roundtrip');
  });

  test('the TypeScript test lane is scoped to the package and never enables interop', () => {
    const [suite] = protocolTestTasks(['--ts-only']);
    expect(suite?.cmd).toEqual(['bun', 'test', '--timeout', '15000', 'packages/protocol']);
    expect(suite?.env).toBeUndefined();
  });

  test('extra bun arguments are appended after the package path', () => {
    const [suite] = protocolTestTasks(['--ts-only'], ['--test-name-pattern', 'codec']);
    expect(suite?.cmd.slice(-3)).toEqual(['packages/protocol', '--test-name-pattern', 'codec']);
  });
});

describe('the protocol tree at the repository root', () => {
  test('the cargo-shim lane pins its toolchain past the root rust-toolchain.toml', () => {
    // rustup resolves `rust-toolchain.toml` by walking up from the working
    // directory, so the protocol workspace's file at the root overrides the one
    // `dtolnay/rust-toolchain` installs for `packages/cargo-shim`. Measured from
    // that directory: "1.98.1 (overridden by '<root>/rust-toolchain.toml')".
    // Without the environment variable the crate silently stops being built
    // against its declared MSRV and the lane still reports green.
    const workflow = readText('.github/workflows/cargo-shim.yml');
    const pinned = /toolchain: (\S+)/.exec(workflow)?.[1];
    expect(pinned).toBeDefined();
    expect(workflow).toContain(`RUSTUP_TOOLCHAIN: ${pinned}`);
    expect(readText('rust-toolchain.toml')).not.toContain(`channel = "${pinned}"`);
  });

  test('the cargo workspace excludes every nested crate it does not own', () => {
    // A package nested under a workspace root that is neither a member nor
    // excluded makes cargo refuse to build it outright.
    const manifest = readText('Cargo.toml');
    expect(manifest).toContain('members = ["crates/mango-protocol"]');
    expect(manifest).toContain('exclude = ["crates/mango-protocol/fuzz", "packages/cargo-shim"]');
  });

  test('the protocol package resolves from source and publishes from a build', () => {
    const manifest = JSON.parse(readText('packages/protocol/package.json')) as {
      exports: Record<string, string>;
      publishConfig: { exports: Record<string, unknown> };
      files: string[];
    };
    // Nothing in the Turbo graph builds dist/ before a typecheck or a test lane
    // (`typecheck` is dependsOn ["^typecheck"], the test lanes declare none), so
    // a dist-pointing workspace link is unresolvable on a clean checkout.
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === './package.json') continue;
      expect(target, subpath).toStartWith('./src/');
      expect(existsSync(join(ROOT_DIR, 'packages/protocol', target)), target).toBe(true);
    }
    // …while the tarball keeps shipping built output.
    expect(Object.keys(manifest.publishConfig.exports)).toContain('.');
    expect(manifest.files).toContain('dist');
  });

  test('every application manifest takes the protocol from the workspace', () => {
    // A registry range here would resolve the published tarball instead of the
    // sibling directory, so a wire change would not reach its consumers until
    // it was released.
    for (const file of [
      'package.json',
      'apps/api/package.json',
      'apps/runtime/package.json',
      'apps/shared/package.json',
    ]) {
      expect(readText(file), file).toContain('"@mangostudio/protocol": "workspace:*"');
    }
  });

  test('a protocol-only change still earns a classification label', () => {
    // The gate fails a pull request with no area:/type: label, and none of the
    // protocol directories match any other glob.
    const labeler = readText('.github/labeler.yml');
    for (const glob of ['spec/**', 'packages/protocol/**', 'crates/**', 'scripts/protocol/**']) {
      expect(labeler, glob).toContain(`- "${glob}"`);
    }
    expect(labeler).not.toContain('mango-protocol/**');
  });
});

describe('the CI path filter reads the same list as everything else', () => {
  const workflow = readText('.github/workflows/protocol-ci.yml');

  /** The `relevant` regex the `changes` job greps the diff with. */
  const relevance = (): RegExp => {
    const literal = /relevant='(\^\([^']+\))'/.exec(workflow)?.[1];
    expect(literal, 'protocol-ci.yml has no `relevant=` regex to read').toBeDefined();
    return new RegExp(literal as string);
  };

  test.each([...PROTOCOL_PATHS, ...PROTOCOL_ROOT_FILES])('the changes job claims %s', (entry) => {
    // Failing open here is silent: no lane runs, the Gate accepts the skip, and
    // the pull request goes green with the Rust half never compiled.
    const probe = entry.endsWith('/') ? `${entry}some/file.rs` : entry;
    expect(relevance().test(probe), `${probe} does not match the changes-job regex`).toBe(true);
  });

  test.each([...PROTOCOL_PATHS])('the push trigger is filtered on %s', (prefix) => {
    expect(workflow, prefix).toContain(`      - "${prefix}**"`);
  });

  test.each([...PROTOCOL_ROOT_FILES])('the push trigger is filtered on %s', (file) => {
    expect(workflow, file).toContain(`      - "${file}"`);
  });

  test('the workflow files itself, so editing the filter reruns the lanes', () => {
    expect(relevance().test('.github/workflows/protocol-ci.yml')).toBe(true);
  });

  test('a change outside the protocol does not trigger the lanes', () => {
    for (const file of ['apps/api/src/index.ts', 'packages/cli/bin/mangostudio.js', 'README.md']) {
      expect(relevance().test(file), file).toBe(false);
    }
  });
});

describe('PROTOCOL_IMPORT_TIP', () => {
  const run = (args: string[]): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync(['git', ...args], { cwd: ROOT_DIR, stdout: 'pipe', stderr: 'pipe' });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
  };

  test('is a full object name, since it is handed to git rev-list', () => {
    // An abbreviation resolves today and can grow ambiguous as history does.
    expect(PROTOCOL_IMPORT_TIP).toMatch(/^[0-9a-f]{40}$/);
  });

  test('names a commit that exists', () => {
    expect(run(['rev-parse', '--verify', `${PROTOCOL_IMPORT_TIP}^{commit}`]).out).toBe(
      PROTOCOL_IMPORT_TIP
    );
  });

  test('both protocol release tags are behind it, so the range excludes them', () => {
    // This is what makes `<tip>..HEAD` mean "everything this repository
    // committed": the imported history is entirely reachable from the tip.
    for (const tag of ['protocol-v0.1.0', 'protocol-v0.2.0']) {
      expect(run(['merge-base', '--is-ancestor', tag, PROTOCOL_IMPORT_TIP]).ok, tag).toBe(true);
    }
  });

  test('it is itself behind HEAD, so the range is not empty of the merge', () => {
    expect(run(['merge-base', '--is-ancestor', PROTOCOL_IMPORT_TIP, 'HEAD']).ok).toBe(true);
  });
});
