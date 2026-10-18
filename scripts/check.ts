import {
  ACTIONS_LINT_LABELS,
  createActionsLintTasks,
  touchesActionsLintSurface,
} from './lib/actions-lint/run';
import { createTurboCheckCommand, createWorkspaceDprintCommand } from './lib/check';
import { checkReportIdentity, checkReportTarget, writeCheckReport } from './lib/check-report';
import type { CheckResult, CheckTaskResult } from './lib/check-result';
import { touchesCodeHealthSurface } from './lib/code-health';
import {
  ROOT_BIOME_PATHS,
  ROOT_DIR,
  ROOT_DPRINT_PATHS,
  WORKSPACE_DPRINT_PATHS,
  type WorkspaceName,
} from './lib/config';
import { touchesContractArtifactSurface } from './lib/contract-artifacts';
import {
  assertDependencyCohort,
  assertNoDisallowedWorkspaceDependencies,
} from './lib/dependency-policy';
import { assertFrontendApiImportBoundary } from './lib/frontend-api-import-boundary';
import { assertNoProductionNodeEnvBranches } from './lib/no-node-env-branches';
import { touchesProtocolSurface } from './lib/protocol';
import { assertVersionsInLockstep } from './lib/release-version';
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
  runTask,
} from './lib/runner';
import { assertNoSharedRootImports } from './lib/shared-root-import-boundary';

function printHelp(): never {
  console.log(`Usage: bun run check [workspace flags] [mode flags]

Runs Biome lint/format and import-cycle checks, dprint, tsc typechecks, Knip code health,
generated contract-artifact freshness, lockfile dedupe, the Mango Protocol
lanes (spec, schema equality, fixtures, Cargo) and workflow static analysis
(actionlint, zizmor, ShellCheck) in parallel.
Default workspace selection: --all
Workspace cycle scans include generated and gitignored TS/JS source files.
Repository .mango/artifacts and .mango/out caches are excluded from scanning.

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
  --report-file <path>  Write an internal JSON result (requires --report-id)
  --report-id <UUID>    Caller identity for --report-file
  --help`);
  process.exit(0);
}

interface CheckTask {
  readonly label: string;
  readonly run: () => Promise<RunResult>;
}

// Keep task identity beside each command so a spawn failure cannot lose its label.
const commandTask = (label: string, cmd: string[], opts: { cwd: string }): CheckTask => ({
  label,
  run: () => runCommand(label, cmd, opts),
});

const localTask = (label: string, fn: () => void): CheckTask => ({
  label,
  run: () => runTask(label, fn),
});

function createWorkspaceTasks(workspaces: ReadonlyArray<WorkspaceName>): CheckTask[] {
  const turboChecks = commandTask('workspaces:check', createTurboCheckCommand([...workspaces]), {
    cwd: ROOT_DIR,
  });
  return [turboChecks, ...createWorkspaceDprintTasks(workspaces)];
}

function createWorkspaceDprintTasks(workspaces: ReadonlyArray<WorkspaceName>): CheckTask[] {
  return workspaces.filter(hasWorkspaceDprintPaths).map(createWorkspaceDprintTask);
}

function createWorkspaceDprintTask(workspace: WorkspaceName): CheckTask {
  return commandTask(`root:dprint:${workspace}`, createWorkspaceDprintCommand(workspace), {
    cwd: ROOT_DIR,
  });
}

function hasWorkspaceDprintPaths(workspace: WorkspaceName): boolean {
  return WORKSPACE_DPRINT_PATHS[workspace].length > 0;
}

function createRootTasks(skipFormat: boolean): CheckTask[] {
  const tasks: CheckTask[] = [
    localTask('root:node-env-branches', () => assertNoProductionNodeEnvBranches()),
    localTask('root:versions', () => {
      assertVersionsInLockstep();
    }),
    localTask('root:dependency-policy', () => assertNoDisallowedWorkspaceDependencies()),
    localTask('root:dependency-cohort', () => assertDependencyCohort()),
    // A lockfile edit (a bump, `bun audit fix`) can leave two versions of a
    // package that one version satisfies, which is how better-auth once got a
    // second @better-auth/core instance. Reads bun.lock only; run `bun dedupe`.
    commandTask('root:dedupe', ['bun', 'dedupe', '--check'], { cwd: ROOT_DIR }),
    commandTask(
      'root:typecheck-scripts',
      ['bunx', 'tsc', '--noEmit', '-p', 'scripts/tsconfig.json'],
      { cwd: ROOT_DIR }
    ),
  ];

  if (!skipFormat) {
    tasks.push(
      commandTask('root:biome', ['bunx', 'biome', 'check', ...ROOT_BIOME_PATHS], { cwd: ROOT_DIR })
    );
    tasks.push(
      commandTask('root:dprint', ['bunx', 'dprint', 'check', ...ROOT_DPRINT_PATHS], {
        cwd: ROOT_DIR,
      })
    );
  }

  return tasks;
}

const { workspaces, includeRoot, flags, values, positional } = parseArgs({
  booleanFlags: ['--staged', '--changed', '--skip-format'],
  valueFlags: ['--base', '--report-file', '--report-id'],
});

if (flags['--help']) {
  printHelp();
}

const reportTarget = checkReportTarget(process.argv.slice(2), values);
const tasks: CheckTask[] = [];
const observed = new Map<string, CheckTaskResult>();
let latestReport: CheckResult | null = null;
const reasonText = (caught: unknown): string =>
  (caught instanceof Error ? caught.message : String(caught)).slice(0, 2000) ||
  'Check setup failed';

const writeReport = (results: CheckTaskResult[], setupError: string | null): void => {
  if (!reportTarget) return;
  const unavailable =
    setupError !== null || results.some((result) => result.state === 'unavailable');
  const report: CheckResult = {
    ...checkReportIdentity(reportTarget),
    state: unavailable ? 'unavailable' : 'completed',
    exitCode:
      unavailable || results.some((result) => result.state === 'executed' && result.exitCode !== 0)
        ? 1
        : 0,
    error: setupError,
    plannedTasks: tasks.map((task) => task.label),
    tasks: results,
  };
  writeCheckReport(reportTarget, report);
  latestReport = report;
};

const pendingResults = (): CheckTaskResult[] =>
  tasks.map(
    (task) =>
      observed.get(task.label) ?? {
        label: task.label,
        state: 'unavailable',
        reason: 'Check did not finish this task',
      }
  );

// An early abort or signal leaves explicit unavailable evidence, never a prior success.
writeReport([], 'Check setup did not finish');

// The supervisor uses process.exit(128 + signal) after stopping descendants.
// Preserve that observed command exit when the host can still write a report.
process.on('exit', (exitCode) => {
  if (
    !reportTarget ||
    !latestReport ||
    latestReport.state !== 'unavailable' ||
    exitCode === 0 ||
    latestReport.exitCode === exitCode
  )
    return;
  try {
    writeCheckReport(reportTarget, { ...latestReport, exitCode });
  } catch (caught) {
    console.error(`Could not finalize Check report: ${reasonText(caught)}`);
  }
});

async function check(): Promise<never> {
  assertNoUnexpectedArguments(positional);

  header('Check');

  let effectiveWorkspaces = [...new Set(workspaces)];
  let effectiveIncludeRoot = includeRoot;
  // Full runs lint workflows whenever root checks run; scoped runs only when a
  // staged/changed file touches the analyzed surface — but then always
  // repository-wide, since workflow findings cross file boundaries.
  let includeActionsLint = includeRoot;
  // Full/root runs always scan the repository. Scoped runs scan only when a
  // changed file can affect Knip's entry graph or dependency report.
  let includeCodeHealth = includeRoot;
  // The generated contract artifacts are what a non-TypeScript runtime is built
  // against, so staleness has to be caught in the pull request that caused it —
  // including on the scoped run the pre-commit hook uses.
  let includeContractArtifacts = includeRoot;
  // The protocol is not a `WorkspaceName`, so the Turbo fan-out above never
  // reaches it: its lane is wired here explicitly. Scoped runs skip it unless a
  // protocol path changed.
  let includeProtocol = includeRoot;

  if (flags['--staged']) {
    const files = getStagedFiles();
    if (files.length === 0) {
      info('No staged files — nothing to check.');
      writeReport([], null);
      process.exit(0);
    }
    const mapped = mapFilesToWorkspaces(files);
    effectiveWorkspaces = mapped.workspaces;
    effectiveIncludeRoot = mapped.includeRoot;
    includeActionsLint = touchesActionsLintSurface(files);
    includeCodeHealth = touchesCodeHealthSurface(files);
    includeContractArtifacts = touchesContractArtifactSurface(files);
    includeProtocol = touchesProtocolSurface(files);
  } else if (flags['--changed']) {
    const base = values['--base'] ?? resolveDefaultBase();
    const files = getChangedFiles(base);
    if (files.length === 0) {
      info('No changed files — nothing to check.');
      writeReport([], null);
      process.exit(0);
    }
    const mapped = mapFilesToWorkspaces(files);
    effectiveWorkspaces = mapped.workspaces;
    effectiveIncludeRoot = mapped.includeRoot;
    includeActionsLint = touchesActionsLintSurface(files);
    includeCodeHealth = touchesCodeHealthSurface(files);
    includeContractArtifacts = touchesContractArtifactSurface(files);
    includeProtocol = touchesProtocolSurface(files);
  }

  if (effectiveWorkspaces.length > 0) {
    info('\nWorkspaces');
    tasks.push(...createWorkspaceTasks(effectiveWorkspaces));
  }

  if (effectiveIncludeRoot) {
    info('\nRoot');
    tasks.push(...createRootTasks(flags['--skip-format']));
  }

  if (includeContractArtifacts) {
    info('\nContract artifacts');
    tasks.push(
      commandTask('root:contract-artifacts', ['bun', 'run', 'contracts:check'], { cwd: ROOT_DIR })
    );
  }

  if (includeProtocol) {
    info('\nMango Protocol');
    // `--ts-only` deliberately: the Rust half (Clippy over the feature powerset,
    // `cargo doc`, the cross-language round trip) is a 25-minute cold lane, and
    // CI's Check job runs this script under a 10-minute budget with no Cargo
    // cache. `.github/workflows/protocol-ci.yml` owns that half, path-filtered.
    // Run `bun run protocol:check` for the full gate before a protocol change.
    tasks.push(
      commandTask('root:protocol', ['bun', './scripts/protocol/check.ts', '--ts-only'], {
        cwd: ROOT_DIR,
      })
    );
  }

  if (includeActionsLint) {
    info('\nWorkflow static analysis');
    tasks.push(
      ...createActionsLintTasks().map((run, index) => ({ label: ACTIONS_LINT_LABELS[index], run }))
    );
  }

  if (includeCodeHealth) {
    info('\nCode health');
    tasks.push(commandTask('root:code-health', ['bun', 'run', 'code-health'], { cwd: ROOT_DIR }));
  }

  // The source scans below parse synchronously on this thread, so they go last:
  // every subprocess task above is already spawned and runs alongside them.
  if (effectiveWorkspaces.includes('frontend')) {
    tasks.push(localTask('frontend:api-import-boundary', () => assertFrontendApiImportBoundary()));
  }
  tasks.push(localTask('root:shared-import-boundary', () => assertNoSharedRootImports()));

  // Ordinary runs retain the runner's existing console and exit behavior.
  // Reported runs also retain every result when an individual spawn/setup throws.
  writeReport(pendingResults(), null);
  const results = await runParallel(
    tasks.map((task) => async () => {
      if (!reportTarget) return task.run();
      try {
        const result = await task.run();
        observed.set(
          task.label,
          result.unavailableReason
            ? {
                label: result.label,
                state: 'unavailable',
                reason: reasonText(result.unavailableReason),
              }
            : {
                label: result.label,
                state: 'executed',
                exitCode: result.exitCode,
                durationMs: result.duration,
              }
        );
        writeReport(pendingResults(), null);
        return result;
      } catch (caught) {
        const reason = reasonText(caught);
        console.error(reason);
        observed.set(task.label, { label: task.label, state: 'unavailable', reason });
        writeReport(pendingResults(), null);
        return { label: task.label, exitCode: 1, duration: 0 };
      }
    })
  );
  writeReport(pendingResults(), null);
  exitWithResults(results);
}

try {
  await check();
} catch (caught) {
  try {
    writeReport(pendingResults(), reasonText(caught));
  } catch (writeFailure) {
    // The original failure stays the thrown error; the report stays unavailable.
    console.error(`Check report not written: ${reasonText(writeFailure)}`);
  }
  throw caught;
}
