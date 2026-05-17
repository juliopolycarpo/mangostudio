import {
  ROOT_BIOME_PATHS,
  ROOT_DIR,
  ROOT_DPRINT_PATHS,
  WORKSPACE_DPRINT_PATHS,
  WORKSPACE_MADGE_PATHS,
  type WorkspaceName,
} from './lib/config';
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
  runWorkspaceScript,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run check [workspace flags] [mode flags]

Runs Biome, dprint, madge circular checks, and tsgo typechecks in parallel.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
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
  const biomeChecks = workspaces.map(
    (workspace) => () => runWorkspaceScript(workspace, 'check:quick')
  );
  const dprintChecks = workspaces
    .filter((workspace) => WORKSPACE_DPRINT_PATHS[workspace].length > 0)
    .map(
      (workspace) => () =>
        runCommand(
          `root:dprint:${workspace}`,
          ['bunx', 'dprint', 'check', ...WORKSPACE_DPRINT_PATHS[workspace]],
          {
            cwd: ROOT_DIR,
          }
        )
    );
  const typechecks = workspaces.map(
    (workspace) => () => runWorkspaceScript(workspace, 'typecheck')
  );
  const madgeChecks = workspaces.map(
    (workspace) => () =>
      runCommand(
        `root:madge:${workspace}:circular`,
        ['bunx', 'madge', '--circular', '--extensions', 'ts,tsx', WORKSPACE_MADGE_PATHS[workspace]],
        { cwd: ROOT_DIR }
      )
  );
  return [...biomeChecks, ...dprintChecks, ...typechecks, ...madgeChecks];
}

function createRootTasks(skipFormat: boolean): Array<() => Promise<RunResult>> {
  const tasks: Array<() => Promise<RunResult>> = [];

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
  booleanFlags: ['--staged', '--changed', '--skip-format', '--skip-lint'],
  valueFlags: ['--base'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

header('Check');

let effectiveWorkspaces = workspaces;
let effectiveIncludeRoot = includeRoot;

if (flags['--staged']) {
  const files = getStagedFiles();
  if (files.length === 0) {
    info('No staged files — nothing to check.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
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

if (tasks.length === 0) {
  info('No affected workspaces — nothing to check.');
  process.exit(0);
}

const results = await runParallel(tasks);

exitWithResults(results);
