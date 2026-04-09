import { ALL_WORKSPACE_NAMES, WORKSPACES, ROOT_DIR } from './lib/config';
import {
  exitWithResults,
  fatal,
  header,
  info,
  runCommand,
  runParallel,
  runWorkspaceScript,
  type RunResult,
} from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run test [lane flags]

Runs the selected test lanes across the repository.
Default lane selection: --all

Lane flags:
  --unit
  --integration
  --e2e
  --all
  --help`);
  process.exit(0);
}

const args = process.argv.slice(2);
let runUnitLane = false;
let runIntegrationLane = false;
let runE2ELane = false;
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
  } else if (arg === '--all') {
    runAllLanes = true;
  } else {
    unexpectedArgs.push(arg);
  }
}

if (unexpectedArgs.length > 0) {
  fatal(`Unknown argument(s): ${unexpectedArgs.join(' ')}`);
}

const hasExplicitLaneSelection = runUnitLane || runIntegrationLane || runE2ELane || runAllLanes;
const shouldRunUnit = runAllLanes || !hasExplicitLaneSelection || runUnitLane;
const shouldRunIntegration = runAllLanes || !hasExplicitLaneSelection || runIntegrationLane;
const shouldRunE2E = runAllLanes || !hasExplicitLaneSelection || runE2ELane;

header('Test');

const results: RunResult[] = [];

if (shouldRunUnit) {
  info('\nPhase: unit');
  const unitResults = await runParallel(
    ALL_WORKSPACE_NAMES.map((workspace) => () => runWorkspaceScript(workspace, 'test:unit'))
  );
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
    const integrationResults = await runParallel(
      integrationWorkspaces.map(
        (workspace) => () => runWorkspaceScript(workspace, 'test:integration', { ifPresent: true })
      )
    );
    results.push(...integrationResults);
  }
}

if (results.some((result) => result.exitCode !== 0)) {
  exitWithResults(results);
}

if (shouldRunE2E) {
  info('\nPhase: e2e');
  const e2eResult = await runCommand('e2e', ['bunx', 'playwright', 'test'], { cwd: ROOT_DIR });
  results.push(e2eResult);
}

exitWithResults(results);
