import { ROOT_DIR, ROOT_LINT_FILES, ROOT_FORMAT_FILES } from './lib/config';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  header,
  info,
  parseArgs,
  runCommand,
  runParallel,
  runWorkspaceScript,
  type RunResult,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run check [workspace flags]

Runs ESLint, Prettier check, and TypeScript typecheck.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
  --all
  --help`);
  process.exit(0);
}

const { workspaces, includeRoot, flags, positional } = parseArgs();

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

header('Check');

const results: RunResult[] = [];

if (workspaces.length > 0) {
  info('\nWorkspaces');
  const wsResults = await runParallel(
    workspaces.map((ws) => () => runWorkspaceScript(ws, 'check'))
  );
  results.push(...wsResults);
}

if (includeRoot) {
  info('\nRoot');
  const rootResults = await runParallel([
    () =>
      runCommand('root:lint', ['bunx', 'eslint', ...ROOT_LINT_FILES, '--max-warnings', '0'], {
        cwd: ROOT_DIR,
      }),
    () =>
      runCommand('root:format:check', ['bunx', 'prettier', '--check', ...ROOT_FORMAT_FILES], {
        cwd: ROOT_DIR,
      }),
  ]);
  results.push(...rootResults);
}

exitWithResults(results);
