import { ROOT_BIOME_PATHS, ROOT_DIR } from './lib/config';
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
  console.log(`Usage: bun run fix [workspace flags] [mode flags]

Runs Biome fixes then residual ESLint --fix.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
  --root     Run root-level fixes only (tooling lint + docs)
  --all

Mode flags:
  --staged       Scope to workspaces touched by staged files
  --changed      Scope to workspaces changed vs origin/main
  --base <ref>   Base ref for --changed (default: merge-base HEAD origin/main)
  --help`);
  process.exit(0);
}

const { workspaces, includeRoot, flags, values, positional } = parseArgs({
  booleanFlags: ['--staged', '--changed'],
  valueFlags: ['--base'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

header('Fix');

let effectiveWorkspaces = workspaces;
let effectiveIncludeRoot = includeRoot;

if (flags['--staged']) {
  const files = getStagedFiles();
  if (files.length === 0) {
    info('No staged files — nothing to fix.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
} else if (flags['--changed']) {
  const base = values['--base'] ?? resolveDefaultBase();
  const files = getChangedFiles(base);
  if (files.length === 0) {
    info('No changed files — nothing to fix.');
    process.exit(0);
  }
  const mapped = mapFilesToWorkspaces(files);
  effectiveWorkspaces = mapped.workspaces;
  effectiveIncludeRoot = mapped.includeRoot;
}

const results: RunResult[] = [];

if (effectiveWorkspaces.length > 0) {
  info('\nWorkspaces');
  const wsResults = await runParallel(
    effectiveWorkspaces.map((ws) => () => runWorkspaceScript(ws, 'fix'))
  );
  results.push(...wsResults);
}

if (effectiveIncludeRoot) {
  info('\nRoot');
  const rootBiomeResult = await runCommand(
    'root:biome:fix',
    ['bunx', 'biome', 'check', '--write', ...ROOT_BIOME_PATHS],
    { cwd: ROOT_DIR }
  );
  results.push(rootBiomeResult);

  if (rootBiomeResult.exitCode !== 0) {
    exitWithResults(results);
  }

  const rootDprintResult = await runCommand('root:dprint:fix', ['bunx', 'dprint', 'fmt'], {
    cwd: ROOT_DIR,
  });
  results.push(rootDprintResult);
}

if (results.length === 0) {
  info('No affected workspaces — nothing to fix.');
  process.exit(0);
}

exitWithResults(results);
