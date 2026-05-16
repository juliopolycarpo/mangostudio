import { ROOT_BIOME_PATHS, ROOT_DIR, ROOT_ESLINT_FILES } from './lib/config';
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

Runs Biome, residual ESLint, and TypeScript typecheck.
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
  --quick        Run check:quick (lint+format only, skip tsc)
  --skip-lint    Skip residual ESLint
  --skip-format  Skip Biome
  --help`);
  process.exit(0);
}

const { workspaces, includeRoot, flags, values, positional } = parseArgs({
  booleanFlags: ['--staged', '--changed', '--quick', '--skip-lint', '--skip-format'],
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

const script = flags['--quick'] ? 'check:quick' : 'check';

const results: RunResult[] = [];

if (effectiveWorkspaces.length > 0) {
  info('\nWorkspaces');
  const wsResults = await runParallel(
    effectiveWorkspaces.map((ws) => () => runWorkspaceScript(ws, script))
  );
  results.push(...wsResults);
}

if (effectiveIncludeRoot) {
  info('\nRoot');
  const rootTasks: Array<() => Promise<RunResult>> = [];
  if (!flags['--skip-lint']) {
    rootTasks.push(() =>
      runCommand('root:eslint', ['bunx', 'eslint', ...ROOT_ESLINT_FILES, '--max-warnings', '0'], {
        cwd: ROOT_DIR,
      })
    );
  }
  if (!flags['--skip-format']) {
    rootTasks.push(() =>
      runCommand('root:biome', ['bunx', 'biome', 'check', ...ROOT_BIOME_PATHS], {
        cwd: ROOT_DIR,
      })
    );
  }
  rootTasks.push(() =>
    runCommand(
      'root:madge:circular',
      ['bunx', 'madge', '--circular', '--extensions', 'ts,tsx', 'apps'],
      { cwd: ROOT_DIR }
    )
  );
  if (rootTasks.length > 0) {
    const rootResults = await runParallel(rootTasks);
    results.push(...rootResults);
  }
}

if (results.length === 0) {
  info('No affected workspaces — nothing to check.');
  process.exit(0);
}

exitWithResults(results);
