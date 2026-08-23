import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BROWSER_SMOKE_TEST_COMMAND } from './lib/browser-smoke';
import { ALL_WORKSPACE_NAMES, ROOT_DIR, type WorkspaceName } from './lib/config';
import {
  exitWithResults,
  fatal,
  header,
  info,
  type RunResult,
  runCommand,
  runParallel,
} from './lib/runner';
import {
  createTurboTestCommand,
  parseShard,
  shardedCoverageWorkspaces,
  type TestShard,
  testLaneEnv,
} from './lib/test';
import { JUNIT_DIR, TIMINGS_DIR } from './lib/test-lanes';

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
  --shard=i/N    Run only shard i of N. Every sharded lane splits its own
                 files, so N shards run on N machines and something must merge
                 the results (scripts/ci/merge-test-shards.ts). The frontend
                 lane is excluded: its LCOV cannot be merged across shards, so
                 CI runs it whole via --only=frontend in its own job.
  --only=<ws>    Run only that workspace's lanes (and skip the root scripts).
  --help`);
  process.exit(0);
}

const args = process.argv.slice(2);
let runUnitLane = false;
let runIntegrationLane = false;
let runE2ELane = false;
let runCoverage = false;
let runAllLanes = false;
let shard: TestShard | null = null;
let only: WorkspaceName | null = null;
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
  } else if (arg.startsWith('--shard=')) {
    try {
      shard = parseShard(arg);
    } catch (caught) {
      fatal(caught instanceof Error ? caught.message : String(caught));
    }
  } else if (arg.startsWith('--only=')) {
    const workspace = arg.slice('--only='.length);
    if (!(ALL_WORKSPACE_NAMES as readonly string[]).includes(workspace)) {
      fatal(`Unknown workspace '${workspace}'. Expected one of: ${ALL_WORKSPACE_NAMES.join(', ')}`);
    }
    only = workspace as WorkspaceName;
  } else {
    unexpectedArgs.push(arg);
  }
}

if (unexpectedArgs.length > 0) {
  fatal(`Unknown argument(s): ${unexpectedArgs.join(' ')}`);
}

// Sharding exists for the coverage lane, which is the only one CI fans out and
// the only one with a merge step behind it. Accepting it on the unit or
// integration lanes would run a fraction of the files and exit 0, which reads
// as a green suite.
if (shard && !runCoverage) {
  fatal('--shard requires --coverage; no other lane has a merge step to reassemble it.');
}

// The two flags answer the same question — "which lanes run here?" — with
// contradictory answers: a shard covers a slice of the sharded lanes, while
// --only names one workspace whole.
if (shard && only) {
  fatal('--shard and --only are mutually exclusive.');
}

// Bun refuses to create the parent directory for `--reporter-outfile` and
// prints `JUnitReportFailed` while still exiting 0 when it is missing — the
// lane's counts silently go to zero. Re-verified on the pinned 1.4.0: running
// `test:scripts` on its own, outside this script, reports 765 passing tests,
// fails to write the report, and exits 0. Create it here rather than in each of
// the six lane scripts. Clearing it first keeps a lane that did not run this
// time from contributing last run's counts to the merged totals.
const junitDir = join(ROOT_DIR, JUNIT_DIR);
await rm(junitDir, { recursive: true, force: true });
await mkdir(junitDir, { recursive: true });

// Created but deliberately NOT cleared: a restored timings file is an input to
// this run, and every shard has to read the same one or they stop agreeing on
// the split (see scripts/ci/merge-timings-shards.ts). Bun tolerates the file
// being absent and falls back to the round-robin split, so a cold cache is
// safe — but it rejects a malformed one outright, which is why nothing here
// writes a placeholder.
await mkdir(join(ROOT_DIR, TIMINGS_DIR), { recursive: true });

const laneEnv = testLaneEnv(shard);

// Which workspaces each turbo fan-out targets. `--only` scopes everything to
// one workspace; a sharded coverage run drops the frontend, whose LCOV cannot
// be reassembled from slices (see shardedCoverageWorkspaces).
const laneWorkspaces: WorkspaceName[] = only ? [only] : [...ALL_WORKSPACE_NAMES];
const coverageWorkspaces: WorkspaceName[] = shard ? shardedCoverageWorkspaces() : laneWorkspaces;
// The root scripts lane has no workspace, so --only leaves it out.
const runRootScripts = only === null;
const rootScriptsTask = runRootScripts
  ? [
      () =>
        runCommand('root:test:scripts', ROOT_SCRIPTS_TEST_COMMAND, { cwd: ROOT_DIR, env: laneEnv }),
    ]
  : [];

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
    ...rootScriptsTask,
    () =>
      runCommand('workspaces:test:unit', createTurboTestCommand('test:unit', laneWorkspaces), {
        cwd: ROOT_DIR,
        env: laneEnv,
      }),
  ]);
  results.push(...unitResults);
}

if (results.some((result) => result.exitCode !== 0)) {
  exitWithResults(results);
}

if (shouldRunIntegration) {
  info('\nPhase: integration');
  const integrationResults = await runParallel([
    () =>
      runCommand(
        'workspaces:test:integration',
        createTurboTestCommand('test:integration', laneWorkspaces),
        { cwd: ROOT_DIR, env: laneEnv }
      ),
  ]);
  results.push(...integrationResults);
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

  // Coverage is the most expensive phase. Bundle the root scripts unit tests
  // here so `--coverage` is a self-contained replacement for `--unit
  // --integration --coverage` on CI, avoiding a duplicate test pass.
  const coverageResults = await runParallel([
    ...rootScriptsTask,
    () =>
      runCommand(
        'workspaces:test:coverage',
        createTurboTestCommand('test:coverage', coverageWorkspaces),
        { cwd: ROOT_DIR, env: laneEnv }
      ),
  ]);
  results.push(...coverageResults);
}

exitWithResults(results);
