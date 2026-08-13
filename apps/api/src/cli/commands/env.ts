/**
 * `env` command: read-only environment matrix (runtimes, version managers, agents).
 */

import type {
  AgentCliStatus,
  AgentCliStatusList,
  RuntimeFinding,
  RuntimeStatus,
  RuntimeStatusList,
  VersionManagerStatus,
  VersionManagerStatusList,
} from '@mangostudio/shared/environments';
import {
  AgentCliStatusListSchema,
  environmentDisplayNamesEn,
  RuntimeStatusListSchema,
  VersionManagerStatusListSchema,
} from '@mangostudio/shared/environments';
import Type from 'typebox';
import Value from 'typebox/value';
import {
  environmentProbingService,
  LOCAL_PROBE_SCOPE,
  type ProbeOptions,
} from '../../modules/environments/application/probing-service';
import type { EnvArgs } from '../args';
import { renderFinding } from '../finding-renderer';
import { writeLine } from '../output';

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
