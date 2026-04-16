import { ROOT_DIR, ROOT_LINT_FILES, ROOT_FORMAT_FILES } from './lib/config';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  getChangedFiles,
  getStagedFiles,
  header,
  info,
  mapFilesToWorkspaces,
  parseArgs,
  resolveDefaultBase,
  runCommand,
  runParallel,
  runWorkspaceScript,
  type RunResult,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run fix [workspace flags] [mode flags]

Runs ESLint --fix then Prettier --write.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
  --root     Run root-level fixes only (tooling lint + doc format)
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
  const rootLintResult = await runCommand(
    'root:lint:fix',
    ['bunx', 'eslint', ...ROOT_LINT_FILES, '--fix', '--max-warnings', '0'],
    { cwd: ROOT_DIR }
  );
  results.push(rootLintResult);

  if (rootLintResult.exitCode !== 0) {
    exitWithResults(results);
  }

  const rootFormatResult = await runCommand(
    'root:format',
    ['bunx', 'prettier', '--write', ...ROOT_FORMAT_FILES],
    { cwd: ROOT_DIR }
  );
  results.push(rootFormatResult);
}

if (results.length === 0) {
  info('No affected workspaces — nothing to fix.');
  process.exit(0);
}

exitWithResults(results);
