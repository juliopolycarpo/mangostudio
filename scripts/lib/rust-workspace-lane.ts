/**
 * The Rust workspace lane of `bun run check`, `bun run test` and
 * `bun run clean`: which cargo commands each one runs, when a scoped run keeps
 * the lane, and which cargo output `clean --rust` removes.
 *
 * The commands are the ones `.github/workflows/cargo-shim.yml` runs in its
 * `workspace` job; `scripts/tests/rust-workspace-lane.unit.test.ts` compares
 * the two, so a flag added to one side fails until the other follows. The
 * workflow keeps its own steps: fmt and Clippy run there before Bun is set up,
 * and Ubuntu's tests run instrumented in `rust-coverage.yml`.
 *
 * The lane is opt-in (`--rust`) and never part of `--all`: Clippy and the
 * tests are minutes cold, CI's Check job has a 10-minute budget and no cargo
 * cache, and the pre-commit hook runs `check --staged`.
 *
 * @example
 * const plan = planRustLane(flags['--rust'] === true, changedFiles);
 * if (plan.run) tasks.push(...chainRustTasks(RUST_CHECK_TASKS, runRustTask));
 */

import { isAbsolute, relative, sep } from 'node:path';

import { scanCrateInputs } from './crate-inputs';
import { captureCommand, type CaptureResult, type RunResult } from './exec';
import { listCheckoutFiles } from './git';
import { cargoTargetDir } from './runtime-build';
import { classifyChangedPaths, RUST_WORKSPACE_PATHS } from './rust-lanes';

/** The executable a task needs on PATH beside `cargo` itself. */
type RustTool = 'cargo' | 'cargo-nextest';

export interface RustLaneTask {
  readonly label: string;
  readonly cmd: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly tool: RustTool;
}

const WORKSPACE_FEATURES = ['--workspace', '--all-features', '--locked'] as const;

/** What `bun run check --rust` runs: rustfmt, Clippy and rustdoc, warnings denied. */
export const RUST_CHECK_TASKS: readonly RustLaneTask[] = [
  { label: 'rust:fmt', cmd: ['cargo', 'fmt', '--all', '--', '--check'], tool: 'cargo' },
  {
    label: 'rust:clippy',
    cmd: [
      'cargo',
      'clippy',
      '--workspace',
      '--all-targets',
      '--all-features',
      '--locked',
      '--',
      '-D',
      'warnings',
    ],
    tool: 'cargo',
  },
  {
    label: 'rust:doc',
    cmd: ['cargo', 'doc', '--no-deps', ...WORKSPACE_FEATURES],
    env: { RUSTDOCFLAGS: '-D warnings' },
    tool: 'cargo',
  },
];

/**
 * What `bun run test --rust` runs. nextest does not run doctests, so they stay
 * on `cargo test --doc`; `--retries 0` keeps a flaky test a failure.
 */
export const RUST_TEST_TASKS: readonly RustLaneTask[] = [
  {
    label: 'rust:nextest',
    cmd: [
      'cargo',
      'nextest',
      'run',
      '--workspace',
      '--all-targets',
      '--all-features',
      '--locked',
      '--retries',
      '0',
    ],
    tool: 'cargo-nextest',
  },
  {
    label: 'rust:doctest',
    cmd: ['cargo', 'test', '--doc', ...WORKSPACE_FEATURES],
    tool: 'cargo',
  },
];

const INSTALL_HINT: Readonly<Record<RustTool, string>> = {
  cargo: 'install the toolchain rust-toolchain.toml pins (https://rustup.rs)',
  'cargo-nextest': 'install the version docs/reference/testing.md names',
};

/**
 * One message per executable the tasks need and PATH lacks. An explicit
 * `--rust` fails on these: skipping with a warning would exit 0 having run
 * nothing.
 *
 * @example
 * missingRustTools(RUST_TEST_TASKS, () => null);
 * // ['(rust lane): expected cargo on PATH | received: not found; install …', …]
 */
export function missingRustTools(
  tasks: readonly RustLaneTask[],
  which: (tool: string) => string | null = Bun.which
): string[] {
  // Every task starts `cargo`, whichever subcommand it then dispatches to.
  const tools = new Set<RustTool>(tasks.flatMap((task) => ['cargo', task.tool] as const));
  return [...tools]
    .filter((tool) => which(tool) === null)
    .map(
      (tool) => `(rust lane): expected ${tool} on PATH | received: not found; ${INSTALL_HINT[tool]}`
    );
}

export interface RustLanePlan {
  readonly run: boolean;
  /** Why a requested lane does not run; absent when it runs or was never requested. */
  readonly skipped?: string;
}

/**
 * Whether the lane runs. `--rust` alone always does. Under `--staged` or
 * `--changed` it runs only when a changed path is one the Rust workspace reads
 * (`RUST_WORKSPACE_PATHS`, the manifest CI's `changes` job classifies with).
 *
 * @example
 * planRustLane(true, ['docs/README.md']);
 * // { run: false, skipped: 'no changed path feeds the Rust workspace' }
 */
export function planRustLane(
  requested: boolean,
  changedFiles: readonly string[] | null
): RustLanePlan {
  if (!requested) return { run: false };
  if (changedFiles === null) return { run: true };
  if (changedFiles.length === 0) return { run: false, skipped: 'no changed files' };
  return classifyChangedPaths(changedFiles).rust
    ? { run: true }
    : { run: false, skipped: 'no changed path feeds the Rust workspace' };
}

/**
 * Whether a full `check` run selected the Rust lane and nothing else: no
 * workspace, no root, no `--staged` or `--changed` file list. The TypeScript
 * source scans have nothing to say about such a run.
 *
 * @example
 * selectsRustLaneAlone(null, [], false); // true, for `bun run check --rust`
 */
export function selectsRustLaneAlone(
  scopedFiles: readonly string[] | null,
  workspaces: readonly string[],
  includeRoot: boolean
): boolean {
  return scopedFiles === null && workspaces.length === 0 && !includeRoot;
}

/**
 * Thunks that run the tasks one after another however the caller starts them,
 * each still reporting its own result. cargo holds one lock on the target
 * directory, so two invocations started together only queue behind it and
 * interleave "Blocking waiting for file lock" with real diagnostics. A failed
 * task does not stop the next: Clippy findings and a rustdoc warning are
 * separate facts.
 *
 * @example
 * await runParallel([...typescriptTasks, ...chainRustTasks(RUST_CHECK_TASKS, runRustTask)]);
 */
export function chainRustTasks(
  tasks: readonly RustLaneTask[],
  run: (task: RustLaneTask) => Promise<RunResult>
): Array<() => Promise<RunResult>> {
  let previous: Promise<unknown> = Promise.resolve();
  return tasks.map((task) => () => {
    const settled = previous.then(() => run(task));
    previous = settled.catch(() => undefined);
    return settled;
  });
}

/** The excluded nightly fuzz workspace's own target directory. */
const FUZZ_TARGET_DIR = 'crates/mango-protocol/fuzz/target';

/**
 * Repository-relative cargo output directories `bun run clean --rust` removes:
 * the workspace target directory and the fuzz workspace's. A `CARGO_TARGET_DIR`
 * outside the repository is refused, because a shared directory there holds
 * other checkouts' builds.
 *
 * @example
 * rustCleanPaths('/repo', { CARGO_TARGET_DIR: 'out' }); // ['out', 'crates/mango-protocol/fuzz/target']
 */
export function rustCleanPaths(
  rootDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string[] {
  const inRepository = relative(rootDir, cargoTargetDir(rootDir, env));
  if (inRepository === '' || inRepository.startsWith('..') || isAbsolute(inRepository)) {
    throw new Error(
      `(clean --rust): expected CARGO_TARGET_DIR inside the repository | received: ${env.CARGO_TARGET_DIR}; ` +
        'remove it with "cargo clean"'
    );
  }
  return [inRepository.split(sep).join('/'), FUZZ_TARGET_DIR];
}

/**
 * Files the Rust tests read that neither `RUST_WORKSPACE_PATHS` nor the crate
 * scan names: the runtime's MCP tests start a Bun fixture, so the Bun pin, the
 * lockfile and the dependency patches decide what that fixture runs.
 */
const RUST_TEST_HOST_INPUTS = ['package.json', 'bun.lock', '.bun-version', 'patches/**'] as const;

/**
 * Every checkout file a Rust test result depends on, for its pass stamp.
 *
 * `RUST_WORKSPACE_PATHS` says when CI runs the lanes, which is not the same
 * question: it leaves out a crate input another lane already guards (the
 * English catalog). A stamp has no other lane behind it, so this adds every
 * file the crate scan finds, exemptions included.
 *
 * @example
 * rustTestInputFiles('/repo', ['crates/x/src/lib.rs', 'docs/a.md']); // ['crates/x/src/lib.rs']
 */
export function rustTestInputFiles(
  rootDir: string,
  checkoutFiles: readonly string[] = listCheckoutFiles(rootDir)
): string[] {
  const scanned = scanCrateInputs(rootDir).map((input) =>
    // A trailing slash names a directory the source appends a file name to.
    input.path.endsWith('/') ? `${input.path}**` : input.path
  );
  const globs = [...RUST_WORKSPACE_PATHS, ...scanned, ...RUST_TEST_HOST_INPUTS].map(
    (pattern) => new Bun.Glob(pattern)
  );
  return checkoutFiles.filter((file) => globs.some((glob) => glob.match(file)));
}

/**
 * Environment variables that change what cargo builds or what a test does.
 * `MANGO_RUNNER_GROUP` is deliberately outside the pattern: it names the
 * parent runner's process and differs on every run.
 */
const RUST_TEST_ENV =
  /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC_.+|RUSTUP_TOOLCHAIN|CARGO_.+|NEXTEST_.+|MANGOSTUDIO_.+)$/;

/**
 * Everything but file bytes that a Rust test result depends on: the task's
 * command and environment, the compiler, cargo, nextest and Bun versions, the
 * host, and the caller's cargo and MangoStudio variables.
 *
 * @example
 * (await rustTestFacts(RUST_TEST_TASKS[0])).cargo; // 'cargo 1.99.0 (…)'
 */
export async function rustTestFacts(
  task: RustLaneTask,
  env: Readonly<Record<string, string | undefined>> = process.env,
  capture: (cmd: string[]) => Promise<CaptureResult> = captureCommand
): Promise<Record<string, string>> {
  const version = async (cmd: string[]): Promise<string> => {
    const { stdout, stderr, exitCode } = await capture(cmd);
    // A tool that cannot report its version still gets a stable, distinct fact.
    return exitCode === 0 ? stdout.trim() : `exit ${exitCode}: ${stderr.trim()}`;
  };
  const selected = Object.entries(env)
    .filter(([name, value]) => RUST_TEST_ENV.test(name) && value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return {
    task: JSON.stringify({ cmd: task.cmd, env: task.env ?? {} }),
    rustc: await version(['rustc', '-Vv']),
    cargo: await version(['cargo', '-V']),
    ...(task.tool === 'cargo-nextest'
      ? { nextest: await version(['cargo', 'nextest', '--version']) }
      : {}),
    bun: `${Bun.version} ${Bun.revision}`,
    host: `${process.platform} ${process.arch}`,
    env: JSON.stringify(selected),
  };
}
