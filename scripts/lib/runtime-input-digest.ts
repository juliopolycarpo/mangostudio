// The digest of everything that determines the UNSTAMPED `mangostudio-runtime`
// binary of one release platform (issue #2698, stage 2). Since the release
// version is stamped after the link (`runtime-stamp.ts`), cargo's output
// depends only on what is hashed here, never on the commit it was built at.
// Nothing consumes the digest yet: the runtime build job publishes the
// unstamped binary under it, and a later stage may reuse it.
//
// Pure and dependency-free (node builtins only): it runs before `bun install`.
// Git and tool execution come in through parameters, so tests drive it with
// named fakes. `scripts/ci/runtime-input-digest.ts` is the CLI.
//
// How each input was established (evidence, not guesswork):
//
//   - Workspace crates. `crates/mangostudio-runtime/Cargo.toml` depends on
//     mango-protocol, mangostudio-runtime-cold, -contract and -core (`cargo
//     build -p` never builds dev-dependencies, and resolver 3 does not unify
//     their features). The launcher is not a dependency. The policy test walks
//     the manifests with `Bun.TOML` instead of a `cargo metadata` fixture: a
//     fixture goes stale silently when a dependency is added, the manifests
//     cannot. Per crate we hash everything tracked except `tests/`,
//     `examples/`, `benches/` and `fuzz/`: cargo never compiles those into a
//     release `bin` (the one `[[bin]]` under `tests/` has `required-features`
//     that no release build enables), and the test suites change on far more
//     commits than the product does. `src/` includes the `#[cfg(test)]`
//     modules, which over-includes on purpose.
//   - Out-of-crate files. `rg "include_str!|include_bytes!|rerun-if-changed|
//     env!\(|option_env!\(" crates` plus `#[path]` finds, in product code, the
//     seven generated runtime-contract JSON files (`mangostudio-runtime-contract`
//     `build.rs` for catalog.json, `include_str!` for the rest) and
//     `apps/shared/src/external-agents/login.json` (`runtime-cold/src/login.rs`).
//     Every other out-of-crate read (`spec/`, the English catalog, the
//     launcher's checksum sample) sits in a test module; the policy test
//     names each with its reason and fails on a new one.
//   - Root `Cargo.toml` (members, `[profile.release]`, `[patch]`, workspace
//     package version that becomes `CARGO_PKG_VERSION`), `Cargo.lock` (every
//     third-party crate version and checksum), `rust-toolchain.toml` and
//     `.cargo/config.toml` (the static CRT flag, the publish-age hold).
//   - `.github/actions/setup-zigbuild/`: pins the zig and cargo-zigbuild
//     versions. The versions the job observes are hashed as well; the file is
//     the declared intent, the observation is what ran.
//   - Build recipe: the exact cargo argv from `cargoRuntimeBuildCommand` (target
//     triple with its `.2.17` glibc suffix, `--release --locked`, zigbuild or
//     build), with the cargo home replaced by a placeholder: it only feeds a
//     `--remap-path-prefix`, the binary never contains it, and a runner that
//     moved its home would otherwise read as a changed input. The profile
//     variant (shipping or light) and the environment that reaches cargo,
//     rustc, the C toolchain and the linker (see `BUILD_ENV_PATTERNS`).
//   - Tools the job can observe before it compiles: `rustc -vV` (pinned by
//     rust-toolchain.toml, includes the LLVM version), `cargo --version`, and for
//     zig-linked targets `zig version` and `cargo zigbuild --version`.
//
// Not hashed, and why:
//
//   - `scripts/build-runtime.ts` and its libraries: they only issue the command
//     above, which is hashed verbatim, and stamp afterwards.
//   - Unobservable from inside the job, so a binary may differ while the digest
//     does not: the runner image (Ubuntu glibc/binutils for host tools, macOS
//     Xcode, SDK and linker, the MSVC toolset and Windows SDK), a
//     `config.toml` under `$CARGO_HOME` or above the checkout, and ignored
//     files inside a crate directory. The image is recorded in the receipt
//     (`ImageOS`, `ImageVersion`, Xcode) but kept out of the digest: images
//     change about weekly, and the maintainer accepted "compiled on an image up
//     to seven days older" for reuse. The determinism evidence (the binary's
//     SHA-256 next to the digest in the step summary) is how drift shows.

import { createHash } from 'node:crypto';

/** Version prefix of the canonical manifest text; bump it when the layout changes. */
const RUNTIME_INPUT_DIGEST_SCHEMA = 'mangostudio-runtime-input-digest/v1';

/** Tracked files hashed as-is. Each must exist in the index. */
export const RUNTIME_INPUT_FILES: readonly string[] = [
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.cargo/config.toml',
  // Read by `mangostudio-runtime-contract/build.rs` (catalog.json) and `include_str!`.
  'apps/shared/src/runtime-contract/generated/catalog.json',
  'apps/shared/src/runtime-contract/generated/hub-catalog.json',
  'apps/shared/src/runtime-contract/generated/health.schema.json',
  'apps/shared/src/runtime-contract/generated/install-output.schema.json',
  'apps/shared/src/runtime-contract/generated/manifest.schema.json',
  'apps/shared/src/runtime-contract/generated/runtime-home.schema.json',
  'apps/shared/src/runtime-contract/generated/strings.json',
  // `include_str!` in `mangostudio-runtime-cold/src/login.rs`.
  'apps/shared/src/external-agents/login.json',
];

/** The workspace crates `mangostudio-runtime` links, including itself. */
export const RUNTIME_CRATE_DIRS: readonly string[] = [
  'crates/mango-protocol',
  'crates/mangostudio-runtime',
  'crates/mangostudio-runtime-cold',
  'crates/mangostudio-runtime-contract',
  'crates/mangostudio-runtime-core',
];

/** Directories of a crate that a release `bin` never compiles. */
const RUNTIME_CRATE_EXCLUDED_DIRS: readonly string[] = [
  'tests',
  'examples',
  'benches',
  'fuzz',
  'target',
];

/** Directories hashed whole (every tracked file under them). */
const RUNTIME_INPUT_TREES: readonly string[] = ['.github/actions/setup-zigbuild'];

/** One `git ls-files -s` row. */
export interface TreeEntry {
  readonly path: string;
  /** Git object id of the file content. */
  readonly blob: string;
  readonly mode: string;
  readonly stage: number;
}

/** A hashed input: path and content id. */
export interface RuntimeInputFile {
  readonly path: string;
  readonly blob: string;
}

/**
 * Whether a repository-relative POSIX path is a runtime input.
 *
 * @example
 * isRuntimeInputPath('crates/mangostudio-runtime/src/main.rs'); // → true
 * isRuntimeInputPath('crates/mangostudio-runtime/tests/it/layout.rs'); // → false
 */
export function isRuntimeInputPath(path: string): boolean {
  if (RUNTIME_INPUT_FILES.includes(path)) return true;
  if (RUNTIME_INPUT_TREES.some((tree) => path.startsWith(`${tree}/`))) return true;
  for (const crate of RUNTIME_CRATE_DIRS) {
    if (!path.startsWith(`${crate}/`)) continue;
    const first = path.slice(crate.length + 1).split('/')[0] as string;
    return !RUNTIME_CRATE_EXCLUDED_DIRS.includes(first);
  }
  return false;
}

/**
 * Parse `git ls-files -s -z` output: `<mode> <blob> <stage>\t<path>` rows
 * separated by NUL.
 *
 * @example
 * parseIndexListing('100644 abc 0\tCargo.toml\0');
 * // → [{ mode: '100644', blob: 'abc', stage: 0, path: 'Cargo.toml' }]
 */
export function parseIndexListing(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const row of output.split('\0')) {
    if (row === '') continue;
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t(.+)$/s.exec(row);
    if (!match) {
      throw new Error(
        `expected git ls-files -s row "<mode> <blob> <stage>\\t<path>" | received: ${JSON.stringify(row)}`
      );
    }
    entries.push({
      mode: match[1] as string,
      blob: match[2] as string,
      stage: Number(match[3]),
      path: match[4] as string,
    });
  }
  return entries;
}

/** One `git status --porcelain -z` row. */
export interface WorktreeChange {
  /** The two status letters, e.g. ` M`, `??`, ` D`. */
  readonly status: string;
  readonly path: string;
}

/**
 * Parse `git status --porcelain -z --no-renames` output (no rename pairs).
 *
 * @example
 * parseWorktreeStatus(' M Cargo.toml\0?? new.rs\0');
 * // → [{ status: ' M', path: 'Cargo.toml' }, { status: '??', path: 'new.rs' }]
 */
export function parseWorktreeStatus(output: string): WorktreeChange[] {
  const changes: WorktreeChange[] = [];
  for (const row of output.split('\0')) {
    if (row === '') continue;
    if (!/^.. ./s.test(row)) {
      throw new Error(`expected git status row "XY <path>" | received: ${JSON.stringify(row)}`);
    }
    changes.push({ status: row.slice(0, 2), path: row.slice(3) });
  }
  return changes;
}

/**
 * The worktree changes that touch a runtime input. Empty means the checkout
 * builds exactly what the index says.
 *
 * @example
 * dirtyRuntimeInputs([{ status: ' M', path: 'README.md' }]); // → []
 */
export function dirtyRuntimeInputs(changes: readonly WorktreeChange[]): WorktreeChange[] {
  return changes.filter((change) => isRuntimeInputPath(change.path));
}

/** Throws unless no runtime input differs from the index. */
export function assertCleanRuntimeInputs(changes: readonly WorktreeChange[]): void {
  const dirty = dirtyRuntimeInputs(changes);
  if (dirty.length === 0) return;
  throw new Error(
    `expected clean runtime inputs (tracked, unmodified) | received: ${dirty
      .map(
        (change) =>
          `${change.status.trim() === '??' ? 'untracked' : change.status.trim()} ${change.path}`
      )
      .join(', ')}`
  );
}

/** Content id of a worktree file, as `git hash-object` reports it. */
export type HashObject = (path: string) => string;

/**
 * Overlay worktree changes onto the index listing, for a local run on a dirty
 * checkout (`--allow-dirty`). Modified and untracked inputs are hashed from
 * disk, deleted ones drop out. CI never calls this.
 *
 * @example
 * applyWorktreeChanges(tree, [{ status: ' M', path: 'Cargo.toml' }], hashObject);
 */
export function applyWorktreeChanges(
  tree: readonly TreeEntry[],
  changes: readonly WorktreeChange[],
  hashObject: HashObject
): TreeEntry[] {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  for (const change of dirtyRuntimeInputs(changes)) {
    if (change.status.includes('D') && !change.status.includes('A')) {
      byPath.delete(change.path);
      continue;
    }
    const previous = byPath.get(change.path);
    byPath.set(change.path, {
      path: change.path,
      blob: hashObject(change.path),
      mode: previous?.mode ?? '100644',
      stage: 0,
    });
  }
  return [...byPath.values()];
}

/** Code-unit order: stable on every platform and locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The runtime inputs in an index listing, sorted by path. Throws, naming the
 * path, when a listed input is missing, conflicted or a submodule, and when a
 * crate or tree contributes no file (a renamed directory).
 *
 * @example
 * selectRuntimeInputs(parseIndexListing(gitLsFilesOutput)); // → [{ path: '.cargo/config.toml', blob: '…' }, …]
 */
export function selectRuntimeInputs(tree: readonly TreeEntry[]): RuntimeInputFile[] {
  const conflicted = tree.filter((entry) => entry.stage !== 0 && isRuntimeInputPath(entry.path));
  if (conflicted.length > 0) {
    throw new Error(
      `expected merged runtime inputs (stage 0) | received: ${conflicted.map((entry) => `${entry.path} stage ${entry.stage}`).join(', ')}`
    );
  }
  const inputs = tree.filter((entry) => isRuntimeInputPath(entry.path));
  const submodules = inputs.filter((entry) => entry.mode === '160000');
  if (submodules.length > 0) {
    throw new Error(
      `expected regular files as runtime inputs | received submodule: ${submodules.map((entry) => entry.path).join(', ')}`
    );
  }
  const present = new Set(inputs.map((entry) => entry.path));
  for (const file of RUNTIME_INPUT_FILES) {
    if (!present.has(file)) {
      throw new Error(`expected tracked runtime input ${file} | received: not in the git index`);
    }
  }
  for (const directory of [...RUNTIME_CRATE_DIRS, ...RUNTIME_INPUT_TREES]) {
    if (![...present].some((path) => path.startsWith(`${directory}/`))) {
      throw new Error(
        `expected tracked runtime input files under ${directory}/ | received: none in the git index`
      );
    }
  }
  return inputs
    .map(({ path, blob }) => ({ path, blob }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}

/**
 * Environment variables whose values reach cargo, rustc, the C toolchain or the
 * linker and can change the output. An allow-list, so a runner secret or a
 * path (`CARGO_HOME`, `CARGO_TARGET_DIR`, `RUSTUP_HOME`) never enters the digest.
 */
const BUILD_ENV_PATTERNS: readonly RegExp[] = [
  /^RUSTFLAGS$/,
  /^RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER|_BOOTSTRAP)?$/,
  /^RUSTUP_TOOLCHAIN$/,
  /^CARGO_ENCODED_RUSTFLAGS$/,
  /^CARGO_INCREMENTAL$/,
  /^CARGO_BUILD_(?:TARGET|RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|INCREMENTAL)$/,
  /^CARGO_PROFILE_[A-Z0-9_]+$/,
  /^CARGO_TARGET_[A-Z0-9_]+_(?:LINKER|RUSTFLAGS)$/,
  /^CARGO_ZIGBUILD_[A-Z0-9_]+$/,
  /^ZIG_[A-Z0-9_]+$/,
  // The `cc` crate (ring's C and assembly) and the system linker driver.
  /^(?:CC|CXX|AR|LD|CFLAGS|CXXFLAGS|LDFLAGS|CPPFLAGS|ASMFLAGS)$/,
  /^(?:CC|CXX|AR|CFLAGS|CXXFLAGS|ASMFLAGS|TARGET_CC|TARGET_CFLAGS)_[A-Za-z0-9_]+$/,
  /^(?:TARGET_CC|TARGET_CFLAGS)$/,
  /^(?:MACOSX_DEPLOYMENT_TARGET|SDKROOT|DEVELOPER_DIR|SOURCE_DATE_EPOCH)$/,
];

/**
 * The build-affecting subset of an environment, sorted by name.
 *
 * @example
 * observeBuildEnv({ HOME: '/h', CARGO_PROFILE_RELEASE_LTO: 'off' }); // → { CARGO_PROFILE_RELEASE_LTO: 'off' }
 */
export function observeBuildEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const observed: Record<string, string> = {};
  for (const name of Object.keys(env).sort(compareCodeUnits)) {
    const value = env[name];
    if (value !== undefined && BUILD_ENV_PATTERNS.some((pattern) => pattern.test(name))) {
      observed[name] = value;
    }
  }
  return observed;
}

/** Result of one tool invocation. */
export interface ToolOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one tool synchronously; the CLI backs it with `Bun.spawnSync`. */
export type ToolRunner = (command: readonly string[]) => ToolOutput;

function observeTool(run: ToolRunner, command: readonly string[]): string {
  let output: ToolOutput;
  try {
    output = run(command);
  } catch (caught) {
    throw new Error(
      `expected ${command.join(' ')} to run | received: ${caught instanceof Error ? caught.message : String(caught)}`
    );
  }
  const text = output.stdout.trim();
  if (output.exitCode !== 0 || text === '') {
    throw new Error(
      `expected ${command.join(' ')} to exit 0 with output | received: exit ${output.exitCode} ${output.stderr.trim() || '(no output)'}`
    );
  }
  return text;
}

/**
 * The tool versions this job can observe before compiling. zig and
 * cargo-zigbuild only count when the build command links through them.
 *
 * @example
 * observeBuildTools(['cargo', 'build', '--release'], run); // → { cargo: '…', rustc: '…' }
 */
export function observeBuildTools(
  command: readonly string[],
  run: ToolRunner
): Record<string, string> {
  const tools: Record<string, string> = {
    // Not `-vV`: its `os:` and `libcurl:` lines name the runner image, which stays out of the digest.
    cargo: observeTool(run, ['cargo', '--version']),
    rustc: observeTool(run, ['rustc', '-vV']),
  };
  if (command[1] === 'zigbuild') {
    tools.zig = observeTool(run, ['zig', 'version']);
    tools['cargo-zigbuild'] = observeTool(run, ['cargo', 'zigbuild', '--version']);
  }
  return tools;
}

/** The non-file inputs: what the build is, and what it ran with. */
export interface RuntimeBuildFacts {
  /** Release platform id, e.g. `linux-x64-musl`. */
  readonly platform: string;
  /** Rust target triple, without the zigbuild glibc suffix. */
  readonly triple: string;
  /** `shipping` or `light`. */
  readonly profile: string;
  /** Cargo profile the command selects (`--release`). */
  readonly cargoProfile: string;
  /** Exact argv, the cargo home replaced by a placeholder. */
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<string, string>>;
}

/** Sorted-key JSON, so equal values serialize to equal bytes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The text the digest hashes: a version line, one `file` row per input in path
 * order, one `fact` row per non-file input in name order. Paths and values are
 * JSON-quoted, so no content can forge a row.
 *
 * @example
 * canonicalRuntimeManifest([{ path: 'Cargo.toml', blob: 'ab' }], facts);
 * // → 'mangostudio-runtime-input-digest/v1\nfile\tab\t"Cargo.toml"\nfact\tcargoProfile\t"release"\n…'
 */
export function canonicalRuntimeManifest(
  files: readonly RuntimeInputFile[],
  facts: RuntimeBuildFacts
): string {
  const rows = [RUNTIME_INPUT_DIGEST_SCHEMA];
  for (const file of [...files].sort((left, right) => compareCodeUnits(left.path, right.path))) {
    rows.push(`file\t${file.blob}\t${JSON.stringify(file.path)}`);
  }
  const record = facts as unknown as Record<string, unknown>;
  for (const name of Object.keys(record).sort(compareCodeUnits)) {
    rows.push(`fact\t${name}\t${canonicalJson(record[name])}`);
  }
  return `${rows.join('\n')}\n`;
}

/**
 * SHA-256 (hex) over the canonical manifest.
 *
 * @example
 * runtimeInputDigest(files, facts); // → '3f2a…' (64 hex characters)
 */
export function runtimeInputDigest(
  files: readonly RuntimeInputFile[],
  facts: RuntimeBuildFacts
): string {
  return createHash('sha256').update(canonicalRuntimeManifest(files, facts)).digest('hex');
}

/**
 * Artifact name of a published unstamped binary. The `runtime-unstamped-`
 * prefix matches none of the download patterns that package a runtime
 * (`runtime-<sha>-*`, `dry-run-runtime-*`), so nothing picks it up by accident.
 *
 * @example
 * unstampedArtifactName('linux-x64', 'ab…'); // → 'runtime-unstamped-linux-x64-ab…'
 */
export function unstampedArtifactName(platform: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`expected a 64-character hex digest | received: ${JSON.stringify(digest)}`);
  }
  return `runtime-unstamped-${platform}-${digest}`;
}

/** Where and by whom the unstamped binary was produced. */
export interface RuntimeProducer {
  readonly runId: string;
  readonly runAttempt: string;
  /** Commit the workflow run is for (`GITHUB_SHA`). */
  readonly sha: string;
  /** Commit the job checked out and built. */
  readonly sourceSha: string;
  readonly repository: string;
  /** Not part of the digest; see the header comment. */
  readonly runner: Readonly<Record<string, string>>;
}

/**
 * The producing run from the Actions environment, plus what the runner image
 * says about itself. Throws, naming the variable, when a run identity is
 * missing: a receipt that cannot name its run is not evidence.
 *
 * Xcode is asked only on macOS and only best effort; the image version already
 * pins it, the extra line is for a human reading the receipt.
 *
 * @example
 * readRuntimeProducer({ GITHUB_RUN_ID: '1', … }, 'linux', run); // → { runId: '1', … }
 */
export function readRuntimeProducer(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  run: ToolRunner
): RuntimeProducer {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`expected ${name} in the environment | received: unset`);
    return value;
  };
  const runner: Record<string, string> = {};
  for (const name of ['ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH']) {
    const value = env[name]?.trim();
    if (value) runner[name] = value;
  }
  if (platform === 'darwin') {
    try {
      runner.xcode = observeTool(run, ['xcodebuild', '-version']).replaceAll('\n', '; ');
    } catch {
      // Unobservable here; the image version above still identifies it.
    }
  }
  return {
    runId: required('GITHUB_RUN_ID'),
    runAttempt: required('GITHUB_RUN_ATTEMPT'),
    sha: required('GITHUB_SHA'),
    sourceSha: required('SOURCE_SHA'),
    repository: required('GITHUB_REPOSITORY'),
    runner,
  };
}

/** The JSON that travels with the published binary. */
export interface RuntimeInputReceipt {
  readonly schema: 'mangostudio-runtime-input-receipt/v1';
  readonly digest: string;
  readonly target: { readonly platform: string; readonly triple: string };
  readonly profile: string;
  /** `rustc -vV` as observed. */
  readonly rustc: string;
  readonly manifest: {
    readonly schema: string;
    readonly files: readonly RuntimeInputFile[];
    readonly facts: RuntimeBuildFacts;
  };
  readonly binary: { readonly name: string; readonly sha256: string; readonly bytes: number };
  readonly producer: RuntimeProducer;
  /** Local `--allow-dirty` runs only; CI never sets it. */
  readonly dirty?: readonly string[];
}

/** Inputs of {@link buildRuntimeInputReceipt}. */
export interface RuntimeReceiptSource {
  readonly digest: string;
  readonly files: readonly RuntimeInputFile[];
  readonly facts: RuntimeBuildFacts;
  readonly binary: RuntimeInputReceipt['binary'];
  readonly producer: RuntimeProducer;
  readonly dirty?: readonly string[];
}

/**
 * Assemble the receipt. Refuses a digest that is not the digest of the files
 * and facts beside it, so a receipt cannot describe inputs it was not computed
 * from.
 *
 * @example
 * buildRuntimeInputReceipt({ digest, files, facts, binary, producer });
 */
export function buildRuntimeInputReceipt(source: RuntimeReceiptSource): RuntimeInputReceipt {
  const recomputed = runtimeInputDigest(source.files, source.facts);
  if (recomputed !== source.digest) {
    throw new Error(
      `expected receipt digest ${recomputed} (digest of its manifest) | received: ${source.digest}`
    );
  }
  return {
    schema: 'mangostudio-runtime-input-receipt/v1',
    digest: source.digest,
    target: { platform: source.facts.platform, triple: source.facts.triple },
    profile: source.facts.profile,
    rustc: source.facts.tools.rustc ?? '',
    manifest: {
      schema: RUNTIME_INPUT_DIGEST_SCHEMA,
      files: source.files,
      facts: source.facts,
    },
    binary: source.binary,
    producer: source.producer,
    ...(source.dirty && source.dirty.length > 0 ? { dirty: source.dirty } : {}),
  };
}

/**
 * Step-summary markdown that puts the digest next to the unstamped binary's
 * SHA-256. Two main runs with the same digest should print the same hash; a
 * maintainer compares them by eye. Evidence only, nothing gates on it.
 *
 * @example
 * renderDeterminismSummary(receipt); // → '### Runtime base linux-x64\n\n| digest | …'
 */
export function renderDeterminismSummary(receipt: RuntimeInputReceipt): string {
  return [
    `### Unstamped runtime ${receipt.target.platform} (${receipt.profile})`,
    '',
    '| Input digest | Unstamped binary SHA-256 | Bytes |',
    '| --- | --- | ---: |',
    `| \`${receipt.digest}\` | \`${receipt.binary.sha256}\` | ${receipt.binary.bytes} |`,
    '',
    'Determinism evidence only: two main runs with the same input digest should print the same SHA-256. Nothing reuses or gates on it yet.',
    '',
  ].join('\n');
}
