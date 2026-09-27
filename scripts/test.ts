import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BROWSER_SMOKE_TEST_COMMAND } from './lib/browser-smoke';
import { ALL_WORKSPACE_NAMES, ROOT_DIR, type WorkspaceName } from './lib/config';
import { touchesProtocolSurface } from './lib/protocol';
import {
  exitWithResults,
  fatal,
  getWorkingTreeChanges,
  header,
  info,
  type RunResult,
  resolveDefaultBase,
  resolveMergeBase,
  runCommand,
  runParallel,
} from './lib/runner';
import {
  type ChangedLane,
  type ChangedLaneRun,
  changedTestArg,
  createChangedTurboTestCommands,
  createTurboTestCommand,
  parseShard,
  planChangedLanes,
  shardedCoverageWorkspaces,
  type TestLaneTask,
  type TestShard,
  testLaneEnv,
} from './lib/test';
import { JUNIT_DIR, TIMINGS_DIR } from './lib/test-lanes';

// `--log-order=stream` for the same reason createTurboTestCommand carries it:
// this lane runs concurrently with the workspace fan-out inside the same
// watchdogged CI step, and Turbo's CI default buffers a task's log until it
// exits — so a lane that never exits contributes nothing to the job log.
const ROOT_SCRIPTS_TEST_COMMAND = [
  'turbo',
  'run',
  '//#test:scripts',
  '--ui=stream',
  '--log-order=stream',
];

// The protocol is not a `WorkspaceName` (see scripts/lib/config.ts), so the
// Turbo fan-out below never reaches it. `--ts-only` for the same reason
// scripts/check.ts passes it: the Cargo suites belong to the path-filtered
// `protocol-ci.yml`, not to every run of this one. Unsharded and in the unit
// phase only — the suite is seconds, and CI's Test job is `--coverage --shard`,
// which never enters this phase, so nothing here runs eight times.
const PROTOCOL_TEST_COMMAND = ['bun', './scripts/protocol/test.ts', '--ts-only'];

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
  --changed      Run only the test files affected by changes since the base
                 (committed, staged, unstaged and untracked), via bun test
                 --changed. A lane whose changes Bun cannot trace — a
                 workspace it imports by package name, or a non-module file —
                 runs whole instead. Not with --coverage; e2e runs whole.
  --base <ref>   Base ref for --changed (default: merge-base HEAD origin/main)
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
let runChanged = false;
let baseRef: string | null = null;
const unexpectedArgs: string[] = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] as string;
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
  } else if (arg === '--changed') {
    runChanged = true;
  } else if (arg === '--base' || arg.startsWith('--base=')) {
    const value = arg === '--base' ? args[++index] : arg.slice('--base='.length);
    if (!value || value.startsWith('-')) {
      fatal(`--base expects a git ref, e.g. --base origin/main; received: '${value ?? ''}'.`);
    }
    baseRef = value;
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

if (baseRef && !runChanged) {
  fatal('--base only applies to --changed.');
}

// A coverage run over a subset of files would fail the total-coverage floors
// for every file it skipped, and its LCOV would feed the merge as if whole.
if (runChanged && runCoverage) {
  fatal('--changed and --coverage are mutually exclusive; coverage floors need the whole suite.');
}

// Bun refuses to create the parent directory for `--reporter-outfile` and
// prints `JUnitReportFailed` while still exiting 0 when it is missing — the
// lane's counts silently go to zero. Measured on 1.4.0 (running `test:scripts`
// on its own, outside this script, reported 765 passing tests, failed to write
// the report, and exited 0) and re-verified on 1.4.2 with a fixture. Create it
// here rather than in each of the six lane scripts. Clearing it first keeps a
// lane that did not run this time from contributing last run's counts to the
// merged totals.
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
// Neither the root scripts lane nor the protocol lane has a workspace, so
// --only leaves both out.
const runRootScripts = only === null;

/** The files changed since the base and how each lane runs over them, or null without --changed. */
function planChangedRun(): { base: string; files: string[]; runs: ChangedLaneRun[] } | null {
  if (!runChanged) return null;
  let base: string;
  try {
    base = baseRef ? resolveMergeBase(baseRef) : resolveDefaultBase();
  } catch (caught) {
    fatal(
      `Cannot resolve --base '${baseRef}': ${caught instanceof Error ? caught.message : caught}`
    );
  }
  const files = getWorkingTreeChanges(base);
  if (files.length === 0) {
    info('No changed files — nothing to test.');
    process.exit(0);
  }
  const lanes: ChangedLane[] = runRootScripts ? ['root', ...laneWorkspaces] : [...laneWorkspaces];
  return { base, files, runs: planChangedLanes(files, lanes) };
}

const changedRun = planChangedRun();
const rootRun = changedRun?.runs.find((run) => run.lane === 'root');
const rootScriptsCommand =
  changedRun && rootRun?.mode === 'changed'
    ? [...ROOT_SCRIPTS_TEST_COMMAND, '--', changedTestArg(changedRun.base)]
    : ROOT_SCRIPTS_TEST_COMMAND;
const rootScriptsTask = runRootScripts
  ? [() => runCommand('root:test:scripts', rootScriptsCommand, { cwd: ROOT_DIR, env: laneEnv })]
  : [];
// The protocol suite is seconds and has no Bun-traceable boundary with the
// spec fixtures and Rust sources it reads, so --changed runs it whole or not
// at all, on the same predicate scripts/check.ts scopes it with.
const runProtocol = runRootScripts && (!changedRun || touchesProtocolSurface(changedRun.files));
const protocolTask = runProtocol
  ? [() => runCommand('root:test:protocol', PROTOCOL_TEST_COMMAND, { cwd: ROOT_DIR })]
  : [];

/** One task per Turbo invocation a workspace test phase needs. */
function workspaceLaneTasks(task: TestLaneTask): (() => Promise<RunResult>)[] {
  const commands = changedRun
    ? createChangedTurboTestCommands(task, changedRun.runs, changedRun.base)
    : [createTurboTestCommand(task, laneWorkspaces)];
  return commands.map((command) => {
    const scoped = command.at(-1)?.startsWith('--changed=') ? ':changed' : '';
    return () =>
      runCommand(`workspaces:${task}${scoped}`, command, { cwd: ROOT_DIR, env: laneEnv });
  });
}

const hasExplicitLaneSelection =
  runUnitLane || runIntegrationLane || runE2ELane || runCoverage || runAllLanes;
const shouldRunUnit = runAllLanes || !hasExplicitLaneSelection || runUnitLane;
const shouldRunIntegration = runAllLanes || !hasExplicitLaneSelection || runIntegrationLane;
// e2e is opt-in only (--e2e or --all); excluded from the implicit default run
const shouldRunE2E = runAllLanes || runE2ELane;

header('Test');

if (changedRun) {
  info(`\n--changed: ${changedRun.files.length} file(s) since ${changedRun.base.slice(0, 12)}`);
  for (const run of changedRun.runs) {
    info(
      `  ${run.lane}: ${run.mode === 'changed' ? 'affected files only' : `whole — ${run.reason}`}`
    );
  }
}

const results: RunResult[] = [];

if (shouldRunUnit) {
  info('\nPhase: unit');
  const unitResults = await runParallel([
    ...rootScriptsTask,
    ...protocolTask,
    ...workspaceLaneTasks('test:unit'),
  ]);
  results.push(...unitResults);
}

if (results.some((result) => result.exitCode !== 0)) {
  exitWithResults(results);
}

if (shouldRunIntegration) {
  info('\nPhase: integration');
  const integrationResults = await runParallel(workspaceLaneTasks('test:integration'));
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
