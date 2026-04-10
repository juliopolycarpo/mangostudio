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
  console.log(`Usage: bun run fix [workspace flags]

Runs ESLint --fix then Prettier --write.
Default workspace selection: --all

Workspace flags:
  --frontend
  --api
  --shared
  --root     Run root-level fixes only (tooling lint + doc format)
  --all
  --help`);
  process.exit(0);
}

const { workspaces, includeRoot, flags, positional } = parseArgs();

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

header('Fix');

const results: RunResult[] = [];

if (workspaces.length > 0) {
  info('\nWorkspaces');
  const wsResults = await runParallel(workspaces.map((ws) => () => runWorkspaceScript(ws, 'fix')));
  results.push(...wsResults);
}

if (includeRoot) {
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

exitWithResults(results);
