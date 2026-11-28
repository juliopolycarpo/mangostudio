import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectRuntimeInputs, stageUnstampedRuntime } from '../ci/runtime-input-digest';
import {
  extractBuildScriptHazards,
  extractBuildScriptInputs,
  extractCompileTimeEnvReads,
  extractUnresolvedReads,
  isInsideCfgTestModule,
  isMountedUnderCfgTest,
} from '../lib/crate-inputs';
import {
  applyWorktreeChanges,
  assertCleanRuntimeInputs,
  buildRuntimeInputReceipt,
  canonicalRuntimeManifest,
  isRuntimeInputPath,
  observeBuildEnv,
  observeBuildTools,
  observeCCompiler,
  parseIndexListing,
  parseWorktreeStatus,
  readRuntimeProducer,
  renderDeterminismSummary,
  type RuntimeBuildFacts,
  runtimeInputDigest,
  selectRuntimeInputs,
  unstampedArtifactName,
} from '../lib/runtime-input-digest';
import {
  RELEASE_STAMP_MAGIC,
  RELEASE_STAMP_SLOT_BYTES,
  stampReleaseVersion,
} from '../lib/runtime-stamp';
import { fakeElf, withTail } from './support/executable-fixtures';
import {
  FakeGit,
  FakeToolRunner,
  indexOf,
  MINIMAL_RUNTIME_TREE,
} from './support/fake-runtime-input-tools';
import { useScratchDirs } from './support/scratch-dirs';

const makeScratchDir = useScratchDirs();

const BASE_OPTIONS = { platform: 'linux-x64', profile: 'shipping', zig: true, allowDirty: false };

function collect(
  overrides: Partial<typeof BASE_OPTIONS> = {},
  git = new FakeGit(indexOf(MINIMAL_RUNTIME_TREE)),
  env: Record<string, string> = {}
) {
  return collectRuntimeInputs(
    git,
    { ...BASE_OPTIONS, ...overrides },
    new FakeToolRunner().run,
    env
  );
}

const FACTS: RuntimeBuildFacts = {
  platform: 'linux-x64',
  triple: 'x86_64-unknown-linux-gnu',
  profile: 'shipping',
  cargoProfile: 'release',
  command: ['cargo', 'zigbuild'],
  env: {},
  tools: { rustc: 'rustc 1.100.0' },
};

describe('isRuntimeInputPath', () => {
  test.each([
    ['Cargo.lock', true],
    ['.cargo/config.toml', true],
    ['apps/shared/src/runtime-contract/generated/catalog.json', true],
    ['.github/actions/setup-zigbuild/action.yml', true],
    ['crates/mangostudio-runtime/src/main.rs', true],
    ['crates/mangostudio-runtime-contract/build.rs', true],
    ['crates/mangostudio-runtime-contract/build_support/compact_json.rs', true],
    ['crates/mango-protocol/Cargo.toml', true],
    ['crates/mangostudio-runtime/tests/it/layout.rs', false],
    ['crates/mango-protocol/examples/echo.rs', false],
    ['crates/mango-protocol/fuzz/Cargo.toml', false],
    ['crates/mangostudio-launcher/src/main.rs', false],
    // A sibling directory that merely shares a crate's prefix.
    ['crates/mangostudio-runtime-extra/src/lib.rs', false],
    ['apps/shared/src/runtime-contract/generated/other.json', false],
    // The root eol rules decide the checked-out bytes of embedded files on Windows.
    ['.gitattributes', true],
    ['apps/api/tests/support/fixtures/file-type/.gitattributes', false],
    ['README.md', false],
  ])('%s -> %p', (path, expected) => {
    expect(isRuntimeInputPath(path)).toBe(expected);
  });
});

describe('parseIndexListing and parseWorktreeStatus', () => {
  test('reads NUL-separated rows, keeping spaces and tabs inside a path', () => {
    expect(parseIndexListing('100644 ab12 0\ta b\tc.rs\u0000160000 cd34 0\tvendor\u0000')).toEqual([
      { mode: '100644', blob: 'ab12', stage: 0, path: 'a b\tc.rs' },
      { mode: '160000', blob: 'cd34', stage: 0, path: 'vendor' },
    ]);
  });

  test('a malformed row names the row', () => {
    expect(() => parseIndexListing('garbage\0')).toThrow(
      'expected git ls-files -s row "<mode> <blob> <stage>\\t<path>" | received: "garbage"'
    );
  });

  test('status rows keep the two status letters and the path', () => {
    expect(parseWorktreeStatus(' M Cargo.toml\0?? new file.rs\0')).toEqual([
      { status: ' M', path: 'Cargo.toml' },
      { status: '??', path: 'new file.rs' },
    ]);
    expect(() => parseWorktreeStatus('M\0')).toThrow(
      'expected git status row "XY <path>" | received: "M"'
    );
  });
});

describe('assertCleanRuntimeInputs and applyWorktreeChanges', () => {
  test('a change to an unhashed file is ignored', () => {
    expect(() =>
      assertCleanRuntimeInputs([
        { status: ' M', path: 'README.md' },
        { status: '??', path: 'crates/mangostudio-runtime/tests/new.rs' },
      ])
    ).not.toThrow();
  });

  test('a modified or untracked input is named with its state', () => {
    expect(() =>
      assertCleanRuntimeInputs([
        { status: ' M', path: 'Cargo.lock' },
        { status: '??', path: 'crates/mango-protocol/src/new.rs' },
      ])
    ).toThrow(
      'expected clean runtime inputs (tracked, unmodified) | received: M Cargo.lock, untracked crates/mango-protocol/src/new.rs'
    );
  });

  test('overlay hashes modified and untracked inputs and drops deleted ones', () => {
    const tree = parseIndexListing(new FakeGit(indexOf(MINIMAL_RUNTIME_TREE)).indexListing());
    const git = new FakeGit([], [], {
      'Cargo.lock': 'f'.repeat(40),
      'crates/mango-protocol/src/new.rs': 'e'.repeat(40),
    });
    const overlaid = applyWorktreeChanges(
      tree,
      [
        { status: ' M', path: 'Cargo.lock' },
        { status: '??', path: 'crates/mango-protocol/src/new.rs' },
        { status: ' D', path: 'rust-toolchain.toml' },
        { status: ' M', path: 'README.md' },
      ],
      git.hashObject
    );
    const byPath = new Map(overlaid.map((entry) => [entry.path, entry.blob]));
    expect(byPath.get('Cargo.lock')).toBe('f'.repeat(40));
    expect(byPath.get('crates/mango-protocol/src/new.rs')).toBe('e'.repeat(40));
    expect(byPath.has('rust-toolchain.toml')).toBe(false);
    expect(git.hashed).toEqual(['Cargo.lock', 'crates/mango-protocol/src/new.rs']);
  });
});

describe('selectRuntimeInputs', () => {
  const tree = (paths: readonly string[]) =>
    parseIndexListing(new FakeGit(indexOf(paths)).indexListing());

  test('keeps only inputs, sorted by path in code-unit order', () => {
    const files = selectRuntimeInputs(tree(MINIMAL_RUNTIME_TREE));
    const paths = files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('crates/mangostudio-runtime/src/main.rs');
    expect(paths).not.toContain('crates/mangostudio-runtime/tests/it/layout.rs');
    expect(paths).not.toContain('crates/mangostudio-launcher/src/main.rs');
    expect(paths).not.toContain('README.md');
  });

  test('a listed input missing from the index is named', () => {
    expect(() =>
      selectRuntimeInputs(tree(MINIMAL_RUNTIME_TREE.filter((path) => path !== 'Cargo.lock')))
    ).toThrow('expected tracked runtime input Cargo.lock | received: not in the git index');
  });

  test('a crate with no tracked file is named', () => {
    expect(() =>
      selectRuntimeInputs(
        tree(MINIMAL_RUNTIME_TREE.filter((path) => !path.startsWith('crates/mango-protocol/')))
      )
    ).toThrow(
      'expected tracked runtime input files under crates/mango-protocol/ | received: none in the git index'
    );
  });

  test('a conflicted input and a submodule are refused', () => {
    const conflicted = parseIndexListing('100644 ab 2\tCargo.lock\0');
    expect(() => selectRuntimeInputs(conflicted)).toThrow(
      'expected merged runtime inputs (stage 0) | received: Cargo.lock stage 2'
    );
    const submodule = parseIndexListing('160000 ab 0\tcrates/mango-protocol/src/vendored\0');
    expect(() => selectRuntimeInputs(submodule)).toThrow(
      'expected regular files as runtime inputs | received submodule: crates/mango-protocol/src/vendored'
    );
  });
});

describe('observeBuildEnv and observeBuildTools', () => {
  test('keeps variables that reach the compiler and drops paths and secrets', () => {
    expect(
      observeBuildEnv({
        HOME: '/home/runner',
        CARGO_HOME: '/home/runner/.cargo',
        CARGO_TARGET_DIR: '/tmp/target',
        CARGO_REGISTRY_TOKEN: 'secret',
        GITHUB_TOKEN: 'secret',
        CARGO_PROFILE_RELEASE_LTO: 'off',
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
        RUSTFLAGS: '-C target-cpu=native',
        CC_x86_64_unknown_linux_musl: 'zig cc',
        MACOSX_DEPLOYMENT_TARGET: '13.0',
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: 'lld',
        CARGO_INCREMENTAL: '0',
      })
    ).toEqual({
      CARGO_INCREMENTAL: '0',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
      CARGO_PROFILE_RELEASE_LTO: 'off',
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: 'lld',
      CC_x86_64_unknown_linux_musl: 'zig cc',
      MACOSX_DEPLOYMENT_TARGET: '13.0',
      RUSTFLAGS: '-C target-cpu=native',
    });
  });

  test('keeps the C toolchain variables the cc crate and MSVC read, host and target forms alike', () => {
    expect(
      observeBuildEnv({
        CRATE_CC_NO_DEFAULTS: '1',
        ARFLAGS: 'rcs',
        ARFLAGS_x86_64_unknown_linux_gnu: 'rcs',
        HOST_CC: 'gcc',
        HOST_CFLAGS: '-O0',
        TARGET_CC: 'zig cc',
        CL: '/MP',
        _CL_: '/Zi',
        LINK: '/DEBUG',
        _LINK_: '/OPT:REF',
        // Near misses stay out.
        LINKS: 'x',
        HOST_HOME: '/h',
        CLIPPY_CONF_DIR: '/c',
      })
    ).toEqual({
      ARFLAGS: 'rcs',
      ARFLAGS_x86_64_unknown_linux_gnu: 'rcs',
      CL: '/MP',
      CRATE_CC_NO_DEFAULTS: '1',
      HOST_CC: 'gcc',
      HOST_CFLAGS: '-O0',
      LINK: '/DEBUG',
      TARGET_CC: 'zig cc',
      _CL_: '/Zi',
      _LINK_: '/OPT:REF',
    });
  });

  test('asks for zig only when the command links through cargo-zigbuild', () => {
    const plain = new FakeToolRunner();
    expect(Object.keys(observeBuildTools(['cargo', 'build'], plain.run))).toEqual([
      'cargo',
      'rustc',
    ]);
    expect(plain.calls).toEqual(['cargo --version', 'rustc -vV']);

    const zig = new FakeToolRunner();
    expect(observeBuildTools(['cargo', 'zigbuild'], zig.run)).toMatchObject({
      zig: '0.15.2',
      'cargo-zigbuild': 'cargo-zigbuild 0.24.1',
    });
  });

  test('a tool that cannot run is named with its exit code', () => {
    const runner = new FakeToolRunner({ 'cargo --version': 'cargo 1.100.0' });
    expect(() => observeBuildTools(['cargo', 'build'], runner.run)).toThrow(
      'expected rustc -vV to exit 0 with output | received: exit 127 rustc -vV: not found'
    );
  });
});

describe('runtimeInputDigest', () => {
  const files = [
    { path: 'Cargo.lock', blob: 'aa' },
    { path: 'Cargo.toml', blob: 'bb' },
  ];

  test('is 64 hex characters and ignores the order the inputs arrive in', () => {
    const digest = runtimeInputDigest(files, FACTS);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(runtimeInputDigest([...files].reverse(), FACTS)).toBe(digest);
  });

  test('is the SHA-256 of the canonical manifest, which names its schema version', () => {
    const text = canonicalRuntimeManifest(files, FACTS);
    expect(text.startsWith('mangostudio-runtime-input-digest/v1\n')).toBe(true);
    expect(runtimeInputDigest(files, FACTS)).toBe(createHash('sha256').update(text).digest('hex'));
  });

  test.each<[string, Partial<RuntimeBuildFacts>]>([
    ['platform', { platform: 'linux-arm64' }],
    ['triple', { triple: 'aarch64-unknown-linux-gnu' }],
    ['profile', { profile: 'light' }],
    ['command', { command: ['cargo', 'build'] }],
    ['env', { env: { RUSTFLAGS: '-C lto' } }],
    ['tools', { tools: { rustc: 'rustc 1.101.0' } }],
  ])('a changed %s changes the digest', (_name, change) => {
    expect(runtimeInputDigest(files, { ...FACTS, ...change })).not.toBe(
      runtimeInputDigest(files, FACTS)
    );
  });

  test('a changed blob, an added file and a renamed file change the digest', () => {
    const base = runtimeInputDigest(files, FACTS);
    expect(runtimeInputDigest([{ path: 'Cargo.lock', blob: 'ab' }, files[1]], FACTS)).not.toBe(
      base
    );
    expect(runtimeInputDigest([...files, { path: 'x', blob: 'cc' }], FACTS)).not.toBe(base);
    expect(runtimeInputDigest([{ path: 'Cargo.lock2', blob: 'aa' }, files[1]], FACTS)).not.toBe(
      base
    );
  });

  test('a path cannot forge a second row', () => {
    const forged = runtimeInputDigest([{ path: 'a\nfile\tbb\t"b"', blob: 'aa' }], FACTS);
    const honest = runtimeInputDigest(
      [
        { path: 'a', blob: 'aa' },
        { path: 'b', blob: 'bb' },
      ],
      FACTS
    );
    expect(forged).not.toBe(honest);
  });
});

describe('collectRuntimeInputs', () => {
  test('the same checkout gives the same digest, and a test-only change does not move it', () => {
    const digest = collect().digest;
    expect(collect().digest).toBe(digest);
    const withExtraTest = new FakeGit(
      indexOf([...MINIMAL_RUNTIME_TREE, 'crates/mango-protocol/tests/new.rs'])
    );
    expect(collect({}, withExtraTest).digest).toBe(digest);
  });

  test('a changed input blob changes the digest', () => {
    const changed = indexOf(MINIMAL_RUNTIME_TREE).map((entry) =>
      entry.path === 'crates/mangostudio-runtime/src/main.rs'
        ? { ...entry, blob: 'f'.repeat(40) }
        : entry
    );
    expect(collect({}, new FakeGit(changed)).digest).not.toBe(collect().digest);
  });

  test('an edit to the root .gitattributes changes the digest, one to a nested file does not', () => {
    const withBlob = (path: string) =>
      new FakeGit(
        indexOf([
          ...MINIMAL_RUNTIME_TREE,
          'apps/api/tests/support/fixtures/file-type/.gitattributes',
        ]).map((entry) => (entry.path === path ? { ...entry, blob: 'a'.repeat(40) } : entry))
      );
    const base = collect({}, withBlob('none')).digest;
    expect(collect({}, withBlob('.gitattributes')).digest).not.toBe(base);
    expect(
      collect({}, withBlob('apps/api/tests/support/fixtures/file-type/.gitattributes')).digest
    ).toBe(base);
  });

  test('a tree without the root .gitattributes is refused by name', () => {
    expect(() =>
      collect(
        {},
        new FakeGit(indexOf(MINIMAL_RUNTIME_TREE.filter((path) => path !== '.gitattributes')))
      )
    ).toThrow('expected tracked runtime input .gitattributes | received: not in the git index');
  });

  test('the platform, the profile and the zig flag are inputs', () => {
    const digests = new Set([
      collect().digest,
      collect({ platform: 'linux-arm64' }).digest,
      collect({ profile: 'light' }).digest,
      collect({ zig: false }).digest,
    ]);
    expect(digests.size).toBe(4);
  });

  test('records the exact command with the cargo home as a placeholder, and the zig tools', () => {
    const { facts } = collect({ platform: 'linux-x64' });
    expect(facts.command.slice(0, 8)).toEqual([
      'cargo',
      'zigbuild',
      '--release',
      '--locked',
      '-p',
      'mangostudio-runtime',
      '--target',
      'x86_64-unknown-linux-gnu.2.17',
    ]);
    expect(facts.command.at(-1)).toContain('--remap-path-prefix=<CARGO_HOME>=/cargo');
    expect(facts.triple).toBe('x86_64-unknown-linux-gnu');
    expect(Object.keys(facts.tools).sort()).toEqual(['cargo', 'cargo-zigbuild', 'rustc', 'zig']);
    expect(Object.keys(collect({ platform: 'darwin-arm64' }).facts.tools).sort()).toEqual([
      'cargo',
      'rustc',
    ]);
  });

  test('environment that reaches the compiler is part of the digest', () => {
    const light = collect({}, undefined, { CARGO_PROFILE_RELEASE_LTO: 'off' });
    expect(light.facts.env).toEqual({ CARGO_PROFILE_RELEASE_LTO: 'off' });
    expect(light.digest).not.toBe(collect().digest);
  });

  test.each([
    [{ platform: 'linux-x65' }, 'expected --platform ids from'],
    [{ platform: '' }, 'expected --platform: exactly one release platform id | received: ""'],
    [{ platform: 'linux-x64,linux-arm64' }, 'expected --platform: exactly one release platform id'],
    [{ profile: 'release' }, 'expected --profile shipping | light | received: "release"'],
  ])('refuses %o', (options, message) => {
    expect(() => collect(options)).toThrow(message);
  });

  test('refuses a modified runtime input unless the run allows it, and then reads the working file', () => {
    const dirtyGit = () =>
      new FakeGit(indexOf(MINIMAL_RUNTIME_TREE), [{ status: ' M', path: 'Cargo.lock' }], {
        'Cargo.lock': 'd'.repeat(40),
      });
    expect(() => collect({}, dirtyGit())).toThrow(
      'expected clean runtime inputs (tracked, unmodified) | received: M Cargo.lock'
    );
    const allowed = collect({ allowDirty: true }, dirtyGit());
    expect(allowed.dirty).toEqual(['Cargo.lock']);
    expect(allowed.files.find((file) => file.path === 'Cargo.lock')?.blob).toBe('d'.repeat(40));
    expect(allowed.digest).not.toBe(collect().digest);
  });

  test('a dirty file outside the inputs does not stop a clean run', () => {
    const git = new FakeGit(indexOf(MINIMAL_RUNTIME_TREE), [{ status: ' M', path: 'README.md' }]);
    expect(collect({}, git).dirty).toEqual([]);
  });
});

/** An unstamped (or stamped) ELF carrying the release stamp slot. */
function runtimeBytes(version: string | null): Uint8Array {
  const slot = new Uint8Array(RELEASE_STAMP_SLOT_BYTES);
  slot.set(RELEASE_STAMP_MAGIC, 0);
  const bytes = withTail(fakeElf({ arch: 'x64', interpreter: null }), slot);
  if (version !== null) stampReleaseVersion(bytes, version);
  return bytes;
}

const PRODUCER = {
  runId: '42',
  runAttempt: '2',
  sha: 'a'.repeat(40),
  sourceSha: 'b'.repeat(40),
  repository: 'owner/repo',
  runner: { ImageVersion: '20260101.1' },
};

describe('stageUnstampedRuntime', () => {
  function stage(version: string | null) {
    const dir = makeScratchDir('runtime-digest-');
    const cargoOutput = join(dir, 'cargo-output');
    writeFileSync(cargoOutput, runtimeBytes(version));
    return {
      dir,
      cargoOutput,
      run: () =>
        stageUnstampedRuntime({
          cargoOutput,
          outDir: join(dir, 'base'),
          binaryName: 'mangostudio-runtime',
          inputs: collect(),
          producer: PRODUCER,
        }),
    };
  }

  test('copies the unstamped bytes beside a receipt that names their SHA-256', () => {
    const { cargoOutput, dir, run } = stage(null);
    const staged = run();
    const bytes = readFileSync(cargoOutput);
    expect(readFileSync(staged.binaryPath).equals(bytes)).toBe(true);
    expect(staged.receipt.binary).toEqual({
      name: 'mangostudio-runtime',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
    expect(staged.artifactName).toBe(`runtime-unstamped-linux-x64-${collect().digest}`);
    expect(staged.receiptPath).toBe(join(dir, 'base', 'receipt.json'));
    expect(JSON.parse(readFileSync(staged.receiptPath, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(staged.receipt))
    );
    expect(staged.receipt).toMatchObject({
      digest: collect().digest,
      target: { platform: 'linux-x64', triple: 'x86_64-unknown-linux-gnu' },
      profile: 'shipping',
      producer: PRODUCER,
    });
    expect(staged.receipt.rustc).toContain('rustc 1.100.0');
    expect(staged.receipt.manifest.files.length).toBeGreaterThan(10);
  });

  test('refuses a stamped binary and writes nothing', () => {
    const { dir, run } = stage('0.2.0');
    expect(run).toThrow(/expected an unstamped runtime at .* \| received release stamp: 0\.2\.0/);
    expect(existsSync(join(dir, 'base'))).toBe(false);
  });
});

describe('buildRuntimeInputReceipt and renderDeterminismSummary', () => {
  const files = [{ path: 'Cargo.toml', blob: 'aa' }];
  const binary = { name: 'mangostudio-runtime', sha256: 'c'.repeat(64), bytes: 1234 };

  test('refuses a digest that is not the digest of its manifest', () => {
    expect(() =>
      buildRuntimeInputReceipt({
        digest: '0'.repeat(64),
        files,
        facts: FACTS,
        binary,
        producer: PRODUCER,
      })
    ).toThrow(
      `expected receipt digest ${runtimeInputDigest(files, FACTS)} (digest of its manifest) | received: ${'0'.repeat(64)}`
    );
  });

  test('marks a dirty local run and leaves a clean one unmarked', () => {
    const digest = runtimeInputDigest(files, FACTS);
    const base = { digest, files, facts: FACTS, binary, producer: PRODUCER };
    expect(buildRuntimeInputReceipt(base)).not.toHaveProperty('dirty');
    expect(buildRuntimeInputReceipt({ ...base, dirty: ['Cargo.toml'] }).dirty).toEqual([
      'Cargo.toml',
    ]);
  });

  test('the summary puts the digest next to the binary hash', () => {
    const digest = runtimeInputDigest(files, FACTS);
    const summary = renderDeterminismSummary(
      buildRuntimeInputReceipt({ digest, files, facts: FACTS, binary, producer: PRODUCER })
    );
    expect(summary).toContain('### Unstamped runtime linux-x64 (shipping)');
    expect(summary).toContain(`| \`${digest}\` | \`${'c'.repeat(64)}\` | 1234 |`);
  });
});

describe('unstampedArtifactName and readRuntimeProducer', () => {
  test('names the artifact from target and digest, and refuses a malformed digest', () => {
    expect(unstampedArtifactName('darwin-arm64', 'a'.repeat(64))).toBe(
      `runtime-unstamped-darwin-arm64-${'a'.repeat(64)}`
    );
    expect(() => unstampedArtifactName('darwin-arm64', 'xyz')).toThrow(
      'expected a 64-character hex digest | received: "xyz"'
    );
  });

  const ENV = {
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SHA: 'a'.repeat(40),
    SOURCE_SHA: 'b'.repeat(40),
    GITHUB_REPOSITORY: 'owner/repo',
    ImageOS: 'ubuntu24',
    ImageVersion: '20260101.1',
  };

  test('reads the run identity and the runner image, and Xcode only on macOS', () => {
    const linux = new FakeToolRunner();
    expect(readRuntimeProducer(ENV, 'linux', linux.run)).toEqual({
      runId: '42',
      runAttempt: '2',
      sha: 'a'.repeat(40),
      sourceSha: 'b'.repeat(40),
      repository: 'owner/repo',
      runner: { ImageOS: 'ubuntu24', ImageVersion: '20260101.1' },
    });
    // Only the C compiler banner (absent from this fake's output); no Xcode off macOS.
    expect(linux.calls).toEqual(['cc --version']);
    expect(readRuntimeProducer(ENV, 'darwin', new FakeToolRunner().run).runner.xcode).toBe(
      'Xcode 26.0; Build version 17A324'
    );
  });

  test('records the C compiler banner in the receipt, and never fails for want of one', () => {
    const runner = new FakeToolRunner({
      'cc --version': 'cc (Ubuntu 13.3.0) 13.3.0\nCopyright',
      'zig cc --version': 'clang version 20.1.2',
    });
    expect(readRuntimeProducer(ENV, 'linux', runner.run).runner.cCompiler).toBe(
      'cc (Ubuntu 13.3.0) 13.3.0; Copyright'
    );
    expect(readRuntimeProducer(ENV, 'linux', runner.run, true).runner.cCompiler).toBe(
      'clang version 20.1.2'
    );
    expect(readRuntimeProducer(ENV, 'linux', new FakeToolRunner({}).run).runner).not.toHaveProperty(
      'cCompiler'
    );
  });

  test('observeCCompiler prefers the CC the environment names and reads the cl banner off stderr', () => {
    const named = new FakeToolRunner({ 'clang-19 --version': 'clang version 19.1.0' });
    expect(observeCCompiler({ CC: 'clang-19' }, 'linux', false, named.run)).toBe(
      'clang version 19.1.0'
    );
    const banner = (): ReturnType<FakeToolRunner['run']> => ({
      exitCode: 2,
      stdout: '',
      stderr: 'Microsoft (R) C/C++ Optimizing Compiler Version 19.44\nusage: cl [ option... ]',
    });
    expect(observeCCompiler({}, 'win32', false, banner)).toBe(
      'Microsoft (R) C/C++ Optimizing Compiler Version 19.44; usage: cl [ option... ]'
    );
    const throws = (): never => {
      throw new Error('spawn cl ENOENT');
    };
    expect(observeCCompiler({}, 'win32', false, throws)).toBeUndefined();
  });

  test('a missing run identity is named, an unreadable Xcode is not fatal', () => {
    expect(() =>
      readRuntimeProducer({ ...ENV, GITHUB_RUN_ID: '' }, 'linux', new FakeToolRunner().run)
    ).toThrow('expected GITHUB_RUN_ID in the environment | received: unset');
    const noXcode = new FakeToolRunner({});
    expect(readRuntimeProducer(ENV, 'darwin', noXcode.run).runner).not.toHaveProperty('xcode');
  });
});

describe('crate input scans for build scripts and compile-time environment', () => {
  test('a build script that joins a ../ literal onto its crate directory is found', () => {
    expect(
      extractBuildScriptInputs(
        'crates/x/build.rs',
        'let a = manifest.join("../../apps/a.json");\n// "../../ignored.json"\nlet b = "src/in-crate.rs";',
        'crates/x'
      )
    ).toEqual([{ source: 'crates/x/build.rs', line: 1, path: 'apps/a.json' }]);
  });

  test('env!, option_env! and (in a build script only) env::var are found, comments are not', () => {
    const text = [
      'let a = env!("CARGO_PKG_VERSION");',
      '/// env!("DOC_ONLY")',
      'let b = option_env!("GITHUB_ACTIONS");',
      'let c = std::env::var("PATH");',
      'let d = env::var_os("OUT_DIR");',
    ].join('\n');
    expect(extractCompileTimeEnvReads('a.rs', text, false).map((read) => read.name)).toEqual([
      'CARGO_PKG_VERSION',
      'GITHUB_ACTIONS',
    ]);
    expect(extractCompileTimeEnvReads('build.rs', text, true)).toEqual([
      { source: 'build.rs', line: 1, name: 'CARGO_PKG_VERSION' },
      { source: 'build.rs', line: 3, name: 'GITHUB_ACTIONS' },
      { source: 'build.rs', line: 4, name: 'PATH' },
      { source: 'build.rs', line: 5, name: 'OUT_DIR' },
    ]);
  });
});

describe('scanner bypasses are reported instead of skipped', () => {
  const unresolved = (text: string) =>
    extractUnresolvedReads('crates/x/src/a.rs', text).map((read) => `${read.line}: ${read.reason}`);

  test('an include with a literal, or from OUT_DIR, is resolved or generated: nothing to report', () => {
    expect(
      unresolved(
        [
          'const A: &str = include_str!("a.json");',
          'const B: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/x.json"));',
          'const C: &str = include_str!(concat!(env!("OUT_DIR"), "/c.json"));',
          '// const D: &str = include_str!(PATH);',
        ].join('\n')
      )
    ).toEqual([]);
  });

  test('an include whose argument holds no literal is named with its argument', () => {
    expect(
      unresolved(
        '\nconst A: &str = include_str!(PATH);\nconst B: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), FILE));'
      )
    ).toEqual([
      '2: include_str! without a string literal: expected a literal path | received: PATH',
      '3: include_bytes! without a string literal: expected a literal path | received: concat!(env!("CARGO_MANIFEST_DIR"), FILE)',
    ]);
  });

  test('a macro_rules! wrapper that expands to an include is named', () => {
    const reads = unresolved(
      'macro_rules! embed {\n    ($path:expr) => {\n        include_str!($path)\n    };\n}\nmacro_rules! plain {\n    () => { 1 };\n}'
    );
    // The wrapper itself, plus the include inside it that has no literal.
    expect(reads).toHaveLength(2);
    expect(reads.join('\n')).toContain('1: macro_rules! embed expands to an include-family macro');
    expect(reads.join('\n')).not.toContain('plain');
  });

  test('an import that could rename an include macro is reported', () => {
    expect(unresolved('use core::include_str as inc;\nconst A: &str = inc!("x.json");')).toEqual([
      '1: import of an include-family macro: expected direct include_str!/include_bytes!/include! | received: use core::include_str as inc;',
    ]);
  });

  test.each([
    ['let up = manifest.parent().unwrap();', '.parent()'],
    ['for dir in manifest.ancestors() {}', '.ancestors()'],
    ['let here = std::env::current_dir().unwrap();', 'current_dir'],
    ['let apps = root.join("apps");', 'literal names a top-level repository path'],
    ['let spec = root.join("./spec/fixtures");', 'literal names a top-level repository path'],
  ])('a build script reaching out with %s is reported', (text, reason) => {
    const hazards = extractBuildScriptHazards('crates/x/build.rs', text, ['apps', 'spec']);
    expect(hazards).toHaveLength(1);
    expect(hazards[0]?.reason).toContain(reason);
  });

  test('a build script that stays in its crate has no hazard', () => {
    expect(
      extractBuildScriptHazards(
        'crates/x/build.rs',
        'let a = manifest.join("../../apps/a.json");\nlet s = "build_support/x.rs";\n// .parent()',
        ['apps', 'spec']
      )
    ).toEqual([]);
  });
});

describe('cfg(test) scoping', () => {
  const text = [
    'const PRODUCT: &str = include_str!("p.json");',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    const T: &str = include_str!("t.json");',
    '}',
    '',
    'fn later() {',
    '    let x = include_str!("l.json");',
    '}',
    '',
    '#[cfg(not(test))]',
    'mod product {',
    '    const N: &str = include_str!("n.json");',
    '}',
    '',
    '#[cfg(all(test, unix))]',
    'pub(crate) mod unix_tests {',
    '    const U: &str = include_str!("u.json");',
    '}',
  ].join('\n');

  test.each([
    [1, false],
    [5, true],
    [9, false],
    [14, false],
    [19, true],
  ])('line %i inside a cfg(test) module: %p', (line, expected) => {
    expect(isInsideCfgTestModule(text, line)).toBe(expected);
  });

  test('a file is mounted under cfg(test) only when the attribute directly precedes the mount', () => {
    expect(isMountedUnderCfgTest('#[cfg(test)]\nmod a_tests;', 'a_tests.rs')).toBe(true);
    expect(
      isMountedUnderCfgTest('#[cfg(test)]\n#[path = "a_tests.rs"]\nmod t;', 'a_tests.rs')
    ).toBe(true);
    expect(isMountedUnderCfgTest('mod a_tests;', 'a_tests.rs')).toBe(false);
    expect(isMountedUnderCfgTest('#[cfg(not(test))]\nmod a_tests;', 'a_tests.rs')).toBe(false);
    expect(isMountedUnderCfgTest('#[cfg(test)]\nmod other;', 'a_tests.rs')).toBe(false);
  });
});
