import { BROWSER_SMOKE_TEST_COMMAND } from './lib/browser-smoke';
import { ALL_WORKSPACE_NAMES, ROOT_DIR, WORKSPACES } from './lib/config';
import {
  exitWithResults,
  fatal,
  header,
  info,
  type RunResult,
  runCommand,
  runParallel,
} from './lib/runner';
import { createTurboTestCommand } from './lib/test';

const ROOT_SCRIPTS_TEST_COMMAND = ['turbo', 'run', '//#test:scripts', '--ui=stream'];

function printHelp(): never {
  console.log(`Usage: bun run test [lane flags]

Runs the selected test lanes across the repository.
Default: unit + integration (e2e is opt-in via --e2e or --all)

Lane flags:
  --unit
  --integration
  --e2e
  --coverage     Run coverage collection across applicable workspaces
  --all          Run all lanes (unit + integration + e2e)
  --help`);
  process.exit(0);
}

const args = process.argv.slice(2);
let runUnitLane = false;
let runIntegrationLane = false;
let runE2ELane = false;
let runCoverage = false;
let runAllLanes = false;
const unexpectedArgs: string[] = [];

for (const arg of args) {
  if (arg === '--help') {
    printHelp();
  } else if (arg === '--unit') {
    runUnitLane = true;
  } else if (arg === '--integration') {
    runIntegrationLane = true;
  } else if (arg === '--e2e') {
    runE2ELane = true;
  } else if (arg === '--coverage') {
    runCoverage = true;
  } else if (arg === '--all') {
    runAllLanes = true;
  } else {
    unexpectedArgs.push(arg);
  }
}

if (unexpectedArgs.length > 0) {
  fatal(`Unknown argument(s): ${unexpectedArgs.join(' ')}`);
}

const hasExplicitLaneSelection =
  runUnitLane || runIntegrationLane || runE2ELane || runCoverage || runAllLanes;
const shouldRunUnit = runAllLanes || !hasExplicitLaneSelection || runUnitLane;
const shouldRunIntegration = runAllLanes || !hasExplicitLaneSelection || runIntegrationLane;
// e2e is opt-in only (--e2e or --all); excluded from the implicit default run
const shouldRunE2E = runAllLanes || runE2ELane;

header('Test');

const results: RunResult[] = [];

if (shouldRunUnit) {
  info('\nPhase: unit');
  const unitResults = await runParallel([
    () => runCommand('root:test:scripts', ROOT_SCRIPTS_TEST_COMMAND, { cwd: ROOT_DIR }),
    () =>
      runCommand('workspaces:test:unit', createTurboTestCommand('test:unit', ALL_WORKSPACE_NAMES), {
        cwd: ROOT_DIR,
      }),
  ]);
  results.push(...unitResults);
}

if (results.some((result) => result.exitCode !== 0)) {
  exitWithResults(results);
}

if (shouldRunIntegration) {
  info('\nPhase: integration');
  const integrationWorkspaces = ALL_WORKSPACE_NAMES.filter(
    (workspace) => WORKSPACES[workspace].hasIntegrationTests
  );

  if (integrationWorkspaces.length > 0) {
    const integrationResults = await runParallel([
      () =>
        runCommand(
          'workspaces:test:integration',
          createTurboTestCommand('test:integration', integrationWorkspaces),
          { cwd: ROOT_DIR }
        ),
    ]);
    results.push(...integrationResults);
  }
}

if (results.some((result) => result.exitCode !== 0)) {
  exitWithResults(results);
}

if (shouldRunE2E) {
  info('\nPhase: e2e');
  const e2eResult = await runCommand('e2e', [...BROWSER_SMOKE_TEST_COMMAND], { cwd: ROOT_DIR });
  results.push(e2eResult);
}

if (results.some((result) => result.exitCode !== 0)) {
  exitWithResults(results);
}

if (runCoverage) {
  info('\nPhase: coverage');
  const coverageWorkspaces = ALL_WORKSPACE_NAMES.filter(
    (workspace) => WORKSPACES[workspace].hasCoverage
  );

  // Coverage is the most expensive phase. Bundle the root scripts unit tests
  // here so `--coverage` is a self-contained replacement for `--unit
  // --integration --coverage` on CI, avoiding a duplicate test pass.
  const coverageResults = await runParallel([
    () => runCommand('root:test:scripts', ROOT_SCRIPTS_TEST_COMMAND, { cwd: ROOT_DIR }),
    () =>
      runCommand(
        'workspaces:test:coverage',
        createTurboTestCommand('test:coverage', coverageWorkspaces),
        { cwd: ROOT_DIR }
      ),
  ]);
  results.push(...coverageResults);
}

exitWithResults(results);
