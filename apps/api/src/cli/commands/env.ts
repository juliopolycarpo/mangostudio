/**
 * `env` command: the read-only environment matrix (runtimes, version
 * managers, agents), and `install`/`update` — the CLI mirror of the
 * Environments page's install flow, for the person sitting at this
 * machine's own terminal.
 */

import type {
  AgentCliStatus,
  AgentCliStatusList,
  InstallAction,
  InstallGuard,
  InstallGuardReason,
  InstallPreparation,
  InstallRecipeId,
  InstallRecipePreview,
  InstallRun,
  InstallRunStatus,
  InstallStartResponse,
  RecipeInput,
  RuntimeFinding,
  RuntimeStatus,
  RuntimeStatusList,
  VersionManagerStatus,
  VersionManagerStatusList,
} from '@mangostudio/shared/environments';
import {
  AgentCliStatusListSchema,
  environmentDisplayNamesEn,
  InstallRecipeIdSchema,
  LOCAL_ENVIRONMENT_ID,
  NodeVersionSpecSchema,
  RuntimeStatusListSchema,
  renderShellCommand,
  VersionManagerStatusListSchema,
} from '@mangostudio/shared/environments';
import Type from 'typebox';
import Value from 'typebox/value';
import { getConfig } from '../../lib/config';
import {
  createInstallService,
  InstallBlockedError,
  InstallConflictError,
  InstallPreparationError,
  type InstallRequestContext,
  type InstallService,
  InstallUnavailableError,
} from '../../modules/environments/application/install-service';
import {
  environmentProbingService,
  LOCAL_PROBE_SCOPE,
  type ProbeOptions,
} from '../../modules/environments/application/probing-service';
import {
  getInstallRecipe,
  type InstallRecipe,
} from '../../modules/environments/domain/install-recipes';
import type { EnvArgs } from '../args';
import { CliError } from '../errors';
import { renderFinding } from '../finding-renderer';
import { writeError, writeLine } from '../output';

export const CliEnvironmentSnapshotSchema = Type.Object({
  runtimes: RuntimeStatusListSchema,
  versionManagers: VersionManagerStatusListSchema,
  agents: AgentCliStatusListSchema,
});

interface CliEnvironmentSnapshot {
  readonly runtimes: RuntimeStatusList;
  readonly versionManagers: VersionManagerStatusList;
  readonly agents: AgentCliStatusList;
}

export interface EnvDeps {
  readonly listRuntimes: (options?: ProbeOptions) => Promise<RuntimeStatus[]>;
  readonly listVersionManagers: (options?: ProbeOptions) => Promise<VersionManagerStatus[]>;
  readonly listAgents: (options?: ProbeOptions) => Promise<AgentCliStatus[]>;
  readonly log: (line: string) => void;
}

/** The scope every CLI install run is recorded under; there is no signed-in session to key it to. */
const CLI_INSTALL_USER_ID = 'local';

export interface EnvInstallDeps {
  readonly service: Pick<InstallService, 'prepare' | 'start' | 'getRunStream' | 'listRuns'>;
  readonly userId: string;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

/**
 * The CLI's own guard: allowed when installs are enabled and this process is
 * not running inside a container. Loopback is meaningless here — the person
 * running this command already has a shell on this machine — so neither
 * `server-not-loopback` nor `client-not-loopback` is ever a reason, unlike
 * the HTTP guard `install-service.ts` uses by default.
 *
 * A remote `--environment` cannot be resolved the way the HTTP guard resolves
 * one: that lookup is scoped to a signed-in user's row in `environments`, and
 * the CLI process shares no such session. Rather than guess at a user, a
 * remote target is always refused with `environment-not-trusted` — the same
 * reason an environment nobody has opted in yet would report.
 *
 * // Usage: await cliInstallGuard({ userId: 'local', clientIp: undefined })
 */
export function cliInstallGuard(context: InstallRequestContext): Promise<InstallGuard> {
  const config = getConfig();
  const environmentId = context.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const reasons: InstallGuardReason[] = [];
  if (!config.environments.installsEnabled) reasons.push('disabled');
  if (environmentId !== LOCAL_ENVIRONMENT_ID) reasons.push('environment-not-trusted');
  else if (config.environments.container) reasons.push('container');
  return Promise.resolve({ allowed: reasons.length === 0, reasons });
}

function resolveInstallDeps(deps: Partial<EnvInstallDeps>): EnvInstallDeps {
  return {
    service: deps.service ?? createInstallService({ resolveGuard: cliInstallGuard }),
    userId: deps.userId ?? CLI_INSTALL_USER_ID,
    log: deps.log ?? writeLine,
    logError: deps.logError ?? writeError,
  };
}

/**
 * `env install` also runs the two recipe shapes `--version` exists for
 * (`use-version` sets a Node version, `set-default` makes one the default);
 * `env update` stays exactly `update`. Neither runs `uninstall` — there is no
 * `env uninstall` subcommand yet, so an uninstall recipe is simply not
 * reachable from the CLI in this pass.
 */
const INSTALL_SUBCOMMAND_ACTIONS: Record<'install' | 'update', readonly InstallAction[]> = {
  install: ['install', 'use-version', 'set-default'],
  update: ['update'],
};

function resolveInstallRecipe(recipeId: string, subcommand: 'install' | 'update'): InstallRecipe {
  if (!Value.Check(InstallRecipeIdSchema, recipeId)) {
    throw new CliError(`Unknown recipe id: ${recipeId}`);
  }
  const recipe = getInstallRecipe(recipeId as InstallRecipeId);
  if (!INSTALL_SUBCOMMAND_ACTIONS[subcommand].includes(recipe.action)) {
    throw new CliError(
      `env ${subcommand} does not run "${recipe.action}" recipes; ${recipe.id} needs a different command.`
    );
  }
  return recipe;
}

/** `--version` only ever applies to a `node-version` recipe, defaulting to `lts` like the API does. */
function buildRecipeInput(recipe: InstallRecipe, version: string | undefined): RecipeInput {
  if (recipe.inputKind === 'node-version') {
    const spec = version ?? 'lts';
    if (!Value.Check(NodeVersionSpecSchema, spec)) {
      throw new CliError(
        `Invalid --version "${spec}"; expected lts, latest, or a numeric version.`
      );
    }
    return { kind: 'node-version', version: spec };
  }
  if (version !== undefined) {
    throw new CliError(`Recipe ${recipe.id} does not accept --version.`);
  }
  return { kind: 'none' };
}

function printPreview(preview: InstallRecipePreview, log: (line: string) => void): void {
  log(`recipe     ${preview.id}`);
  log(`argv       ${renderShellCommand(preview.argv)}`);
  if (preview.writes.length > 0) log(`writes     ${preview.writes.join(', ')}`);
  log(`network    ${preview.networkAccess ? 'yes' : 'no'}`);
  if (preview.download) {
    log(`download   ${preview.download.url}`);
    if (preview.download.sizeBytes !== undefined) {
      log(`size       ${preview.download.sizeBytes} bytes`);
    }
    if (preview.download.sha256) log(`sha256     ${preview.download.sha256}`);
  }
  const reason = preview.unrunnableReason ? ` (${preview.unrunnableReason})` : '';
  log(`runnable   ${preview.runnable}${reason}`);
}

/** Everything that refused this recipe, then the command to run by hand instead. */
function printRefusal(preview: InstallRecipePreview, log: (line: string) => void): void {
  if (!preview.guard.allowed) log(`blocked    ${preview.guard.reasons.join(', ')}`);
  if (!preview.supported) log('blocked    not supported on this platform');
  if (preview.missingRequirements.length > 0) {
    log(`blocked    missing ${preview.missingRequirements.join(', ')}`);
  }
  log('Run this instead:');
  log(`  ${preview.copyCommand}`);
}

/**
 * `mangostudio env install <recipe>` / `env update <recipe>`: the same
 * install service the API uses, run from a terminal instead of a browser.
 *
 * Returns the process exit code rather than calling `process.exit` itself —
 * 0 on a run that finished `succeeded`, 1 on any other terminal status or a
 * conflict/preparation failure, 2 when the recipe never started at all
 * (blocked by the guard, unsupported, missing a requirement, or copy-only).
 * `dispatch.ts` is the one place that turns this into `process.exitCode`, so
 * a test can call this directly and read the number back.
 *
 * The CLI process shares this machine's SQLite database with a running hub,
 * but not its in-process dedupe of active runs — two processes racing the
 * same recipe both spawn a child rather than one attaching to the other's.
 * Nothing here solves that; it is out of scope for this pass.
 */
export async function runEnvInstall(
  args: EnvArgs,
  deps: Partial<EnvInstallDeps> = {}
): Promise<number> {
  if (args.subcommand !== 'install' && args.subcommand !== 'update') {
    throw new CliError(`runEnvInstall called with subcommand "${String(args.subcommand)}".`);
  }
  if (args.recipeId === undefined) {
    throw new CliError(`Missing recipe id for env ${args.subcommand}.`);
  }

  const d = resolveInstallDeps(deps);
  const recipe = resolveInstallRecipe(args.recipeId, args.subcommand);
  const input = buildRecipeInput(recipe, args.version);
  const context: InstallRequestContext = { userId: d.userId, clientIp: undefined };
  const requestBody = {
    recipeId: recipe.id,
    input,
    ...(args.environmentId !== undefined && { environmentId: args.environmentId }),
  };

  let preview: InstallRecipePreview;
  let preparationId: string | null;
  try {
    const preparation: InstallPreparation = await d.service.prepare(requestBody, context);
    preview = preparation.recipe;
    preparationId = preparation.preparationId;
  } catch (error) {
    if (error instanceof InstallBlockedError || error instanceof InstallUnavailableError) {
      printPreview(error.recipe, d.log);
      printRefusal(error.recipe, d.log);
      return 2;
    }
    throw error;
  }

  printPreview(preview, d.log);

  let started: InstallStartResponse;
  try {
    started = await d.service.start(
      { ...requestBody, ...(preparationId !== null && { preparationId }) },
      context
    );
  } catch (error) {
    if (error instanceof InstallBlockedError || error instanceof InstallUnavailableError) {
      printRefusal(error.recipe, d.log);
      return 2;
    }
    if (error instanceof InstallConflictError || error instanceof InstallPreparationError) {
      d.logError(error.message);
      return 1;
    }
    throw error;
  }

  const stream = await d.service.getRunStream(started.runId, d.userId);
  let status: InstallRunStatus = 'failed';
  if (stream) {
    for await (const event of stream) {
      if (event.type === 'log') d.log(event.line);
      else if (event.type === 'exit') status = event.status;
      else if (event.type === 'error') d.logError(event.error);
    }
  }

  if (args.json) {
    const runs = await d.service.listRuns(d.userId);
    const run = runs.find((candidate: InstallRun) => candidate.id === started.runId);
    if (run) d.log(JSON.stringify(run, null, 2));
  }

  return status === 'succeeded' ? 0 : 1;
}

function displayName(id: string): string {
  return (environmentDisplayNamesEn as Record<string, string | undefined>)[id] ?? id;
}

function primaryFindingDetail(status: {
  readonly findings: readonly RuntimeFinding[];
}): string | null {
  const first = status.findings[0];
  return first ? renderFinding(first) : null;
}

function formatRuntimeSummary(status: RuntimeStatus): string {
  const name = displayName(status.id).padEnd(14);
  if (status.effective) {
    return `${name}${status.effective.version}  ${status.effective.path}`;
  }
  const detail = primaryFindingDetail(status);
  return detail ? `${name}${detail}` : `${name}(not detected)`;
}

function formatVersionManagerSummary(status: VersionManagerStatus): string {
  const name = displayName(status.id).padEnd(14);
  if (!status.installed) {
    const detail = primaryFindingDetail(status);
    return detail ? `${name}${detail}` : `${name}not installed`;
  }
  const version = status.managerVersion ?? 'installed';
  const managed = status.versions.length;
  const suffix = managed > 0 ? `  ${managed} version${managed === 1 ? '' : 's'} managed` : '';
  return `${name}${version}${suffix}`;
}

function formatAgentSummary(status: AgentCliStatus): string {
  const name = displayName(status.targetId).padEnd(14);
  if (status.effective) {
    return `${name}${status.effective.version}  ${status.effective.path}`;
  }
  const detail = primaryFindingDetail(status);
  return detail ? `${name}${detail}` : `${name}(not detected)`;
}

function printRuntimeDetail(status: RuntimeStatus, log: (line: string) => void): void {
  log(`\n${displayName(status.id)} (${status.health})`);
  if (status.effective) {
    log(`  effective  ${status.effective.version}  ${status.effective.path}`);
  }
  for (const installation of status.installations) {
    const marker = installation.effective ? ' *' : '';
    const pathIndex =
      installation.pathIndex !== undefined ? `  PATH #${installation.pathIndex + 1}` : '';
    log(`  ${installation.version}  ${installation.path}${pathIndex}${marker}`);
  }
  for (const finding of status.findings) {
    log(`  ! ${renderFinding(finding)}`);
  }
}

function printAgentDetail(status: AgentCliStatus, log: (line: string) => void): void {
  log(`\n${displayName(status.targetId)} (${status.health})`);
  if (status.effective) {
    log(`  version  ${status.effective.version}  ${status.effective.path}`);
  }
  log(`  config     ${status.configHome}${status.configHomeExists ? '' : ' (missing)'}`);
  log(`  auth       ${status.authenticated ? 'signed in' : 'not signed in'}`);
  for (const finding of status.findings) {
    log(`  ! ${renderFinding(finding)}`);
  }
}

async function loadSnapshot(deps: EnvDeps): Promise<CliEnvironmentSnapshot> {
  const [runtimes, versionManagers, agents] = await Promise.all([
    deps.listRuntimes(),
    deps.listVersionManagers(),
    deps.listAgents(),
  ]);
  return { runtimes, versionManagers, agents };
}

export async function runEnv(
  options: EnvArgs = { subcommand: null, json: false },
  deps: Partial<EnvDeps> = {}
): Promise<void> {
  const d = resolveDeps(deps);
  const snapshot = await loadSnapshot(d);

  if (options.json) {
    if (!Value.Check(CliEnvironmentSnapshotSchema, snapshot)) {
      throw new Error('Internal error: env snapshot failed schema validation.');
    }
    d.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  if (options.subcommand === 'runtimes') {
    d.log('Runtimes');
    for (const runtime of snapshot.runtimes) {
      printRuntimeDetail(runtime, d.log);
    }
    d.log('\nVersion managers');
    for (const manager of snapshot.versionManagers) {
      if (!manager.installed && manager.findings.length === 0) continue;
      const detail = primaryFindingDetail(manager);
      d.log(`  ${displayName(manager.id).padEnd(14)}${detail ?? manager.managerVersion ?? 'ok'}`);
    }
    return;
  }

  if (options.subcommand === 'agents') {
    d.log('Agent CLIs');
    for (const agent of snapshot.agents) {
      printAgentDetail(agent, d.log);
    }
    return;
  }

  d.log('Runtimes');
  for (const runtime of snapshot.runtimes) {
    d.log(`  ${formatRuntimeSummary(runtime)}`);
  }
  d.log('\nVersion managers');
  for (const manager of snapshot.versionManagers) {
    d.log(`  ${formatVersionManagerSummary(manager)}`);
  }
  d.log('\nAgent CLIs');
  for (const agent of snapshot.agents) {
    d.log(`  ${formatAgentSummary(agent)}`);
  }
}

function resolveDeps(deps: Partial<EnvDeps>): EnvDeps {
  return {
    listRuntimes:
      deps.listRuntimes ??
      ((opts) => environmentProbingService.listRuntimeStatuses(LOCAL_PROBE_SCOPE, opts)),
    listVersionManagers:
      deps.listVersionManagers ??
      ((opts) => environmentProbingService.listVersionManagerStatuses(LOCAL_PROBE_SCOPE, opts)),
    listAgents:
      deps.listAgents ??
      ((opts) => environmentProbingService.listAgentCliStatuses(LOCAL_PROBE_SCOPE, opts)),
    log: deps.log ?? writeLine,
  };
}
