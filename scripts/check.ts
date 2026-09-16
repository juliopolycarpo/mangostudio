import { createActionsLintTasks, touchesActionsLintSurface } from './lib/actions-lint/run';
import { createTurboCheckCommand, createWorkspaceDprintCommand } from './lib/check';
import { touchesCodeHealthSurface } from './lib/code-health';
import {
  ROOT_BIOME_PATHS,
  ROOT_DIR,
  ROOT_DPRINT_PATHS,
  WORKSPACE_DPRINT_PATHS,
  type WorkspaceName,
} from './lib/config';
import { touchesContractArtifactSurface } from './lib/contract-artifacts';
import {
  assertDependencyCohort,
  assertNoDisallowedWorkspaceDependencies,
} from './lib/dependency-policy';
import { assertNoProductionNodeEnvBranches } from './lib/no-node-env-branches';
import { touchesProtocolSurface } from './lib/protocol';
import { assertVersionsInLockstep } from './lib/release-version';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  getChangedFiles,
  getStagedFiles,
  header,
  info,
  mapFilesToWorkspaces,
  parseArgs,
  type RunResult,
  resolveDefaultBase,
  runCommand,
  runParallel,
  runTask,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run check [workspace flags] [mode flags]

Runs Biome, dprint, madge circular checks, tsc typechecks, Knip code health,
generated contract-artifact freshness, the Mango Protocol lanes (spec, schema
equality, fixtures, Cargo) and workflow static analysis (actionlint, zizmor,
ShellCheck) in parallel.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
  --runtime
  --root     Run root-level checks only (tooling lint + docs)
  --all

Mode flags:
  --staged       Scope to workspaces touched by staged files
  --changed      Scope to workspaces changed vs origin/main
  --base <ref>   Base ref for --changed (default: merge-base HEAD origin/main)
  --skip-format  Skip root Biome and dprint
  --help`);
  process.exit(0);
}

function createWorkspaceTasks(
  workspaces: ReadonlyArray<WorkspaceName>
): Array<() => Promise<RunResult>> {
  const turboChecks = () =>
    runCommand('workspaces:check', createTurboCheckCommand([...workspaces]), {
      cwd: ROOT_DIR,
    });
  return [turboChecks, ...createWorkspaceDprintTasks(workspaces)];
}

function createWorkspaceDprintTasks(
  workspaces: ReadonlyArray<WorkspaceName>
): Array<() => Promise<RunResult>> {
  return workspaces.filter(hasWorkspaceDprintPaths).map(createWorkspaceDprintTask);
}

function createWorkspaceDprintTask(workspace: WorkspaceName): () => Promise<RunResult> {
  return () =>
    runCommand(`root:dprint:${workspace}`, createWorkspaceDprintCommand(workspace), {
      cwd: ROOT_DIR,
    });
}

function hasWorkspaceDprintPaths(workspace: WorkspaceName): boolean {
  return WORKSPACE_DPRINT_PATHS[workspace].length > 0;
}

function createRootTasks(skipFormat: boolean): Array<() => Promise<RunResult>> {
  const tasks: Array<() => Promise<RunResult>> = [
    () => runTask('root:node-env-branches', () => assertNoProductionNodeEnvBranches()),
    () =>
      runTask('root:versions', () => {
        assertVersionsInLockstep();
      }),
    () => runTask('root:dependency-policy', () => assertNoDisallowedWorkspaceDependencies()),
    () => runTask('root:dependency-cohort', () => assertDependencyCohort()),
    () =>
      runCommand(
        'root:typecheck-scripts',
        ['bunx', 'tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
        { cwd: ROOT_DIR }
      ),
  ];

  if (!skipFormat) {
    tasks.push(() =>
      runCommand('root:biome', ['bunx', 'biome', 'check', ...ROOT_BIOME_PATHS], { cwd: ROOT_DIR })
    );
    tasks.push(() =>
      runCommand('root:dprint', ['bunx', 'dprint', 'check', ...ROOT_DPRINT_PATHS], {
        cwd: ROOT_DIR,
      })
    );
  }

  return tasks;
}

const { workspaces, includeRoot, flags, values, positional } = parseArgs({
  booleanFlags: ['--staged', '--changed', '--skip-format'],
  valueFlags: ['--base'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

header('Check');

let effectiveWorkspaces = workspaces;
let effectiveIncludeRoot = includeRoot;
// Full runs lint workflows whenever root checks run; scoped runs only when a
// staged/changed file touches the analyzed surface — but then always
// repository-wide, since workflow findings cross file boundaries.
let includeActionsLint = includeRoot;
// Full/root runs always scan the repository. Scoped runs scan only when a
// changed file can affect Knip's entry graph or dependency report.
let includeCodeHealth = includeRoot;
// The generated contract artifacts are what a non-TypeScript runtime is built
// against, so staleness has to be caught in the pull request that caused it —
// including on the scoped run the pre-commit hook uses.
let includeContractArtifacts = includeRoot;
// The protocol is not a `WorkspaceName`, so the Turbo fan-out above never
// reaches it: its lane is wired here explicitly. Scoped runs skip it unless a
// protocol path changed.
let includeProtocol = includeRoot;

if (flags['--staged']) {
  const files = getStagedFiles();
  if (files.length === 0) {
    info('No staged files — nothing to check.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
  includeActionsLint = touchesActionsLintSurface(files);
  includeCodeHealth = touchesCodeHealthSurface(files);
  includeContractArtifacts = touchesContractArtifactSurface(files);
  includeProtocol = touchesProtocolSurface(files);
} else if (flags['--changed']) {
  const base = values['--base'] ?? resolveDefaultBase();
  const files = getChangedFiles(base);
  if (files.length === 0) {
    info('No changed files — nothing to check.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
  includeActionsLint = touchesActionsLintSurface(files);
  includeCodeHealth = touchesCodeHealthSurface(files);
  includeContractArtifacts = touchesContractArtifactSurface(files);
  includeProtocol = touchesProtocolSurface(files);
}

const tasks: Array<() => Promise<RunResult>> = [];

if (effectiveWorkspaces.length > 0) {
  info('\nWorkspaces');
  tasks.push(...createWorkspaceTasks(effectiveWorkspaces));
}

if (effectiveIncludeRoot) {
  info('\nRoot');
  tasks.push(...createRootTasks(flags['--skip-format']));
}

if (includeContractArtifacts) {
  info('\nContract artifacts');
  tasks.push(() =>
    runCommand('root:contract-artifacts', ['bun', 'run', 'contracts:check'], { cwd: ROOT_DIR })
  );
}

if (includeProtocol) {
  info('\nMango Protocol');
  // `--ts-only` deliberately: the Rust half (Clippy over the feature powerset,
  // `cargo doc`, the cross-language round trip) is a 25-minute cold lane, and
  // CI's Check job runs this script under a 10-minute budget with no Cargo
  // cache. `.github/workflows/protocol-ci.yml` owns that half, path-filtered.
  // Run `bun run protocol:check` for the full gate before a protocol change.
  tasks.push(() =>
    runCommand('root:protocol', ['bun', './scripts/protocol/check.ts', '--ts-only'], {
      cwd: ROOT_DIR,
    })
  );
}

if (includeActionsLint) {
  info('\nWorkflow static analysis');
  tasks.push(...createActionsLintTasks());
}

if (includeCodeHealth) {
  info('\nCode health');
  tasks.push(() =>
    runCommand('root:code-health', ['bun', 'run', 'code-health'], { cwd: ROOT_DIR })
  );
}

if (tasks.length === 0) {
  info('No affected workspaces — nothing to check.');
  process.exit(0);
}

const results = await runParallel(tasks);

exitWithResults(results);
