/**
 * Environments section for `mango doctor`.
 */

import type {
  AgentCliStatus,
  RuntimeStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { environmentDisplayNamesEn } from '@mangostudio/shared/environments';
import {
  environmentProbingService,
  LOCAL_PROBE_SCOPE,
  type ProbeOptions,
} from '../modules/environments/application/probing-service';
import type { CheckResult } from './doctor-checks';
import { fail, ok, warn } from './doctor-checks';
import { findingSeverity, renderFinding, runtimeHealthToCheckStatus } from './finding-renderer';

export interface EnvironmentDoctorDeps {
  readonly listRuntimes: (options?: ProbeOptions) => Promise<RuntimeStatus[]>;
  readonly listVersionManagers: (options?: ProbeOptions) => Promise<VersionManagerStatus[]>;
  readonly listAgents: (options?: ProbeOptions) => Promise<AgentCliStatus[]>;
}

function displayName(id: string): string {
  return (environmentDisplayNamesEn as Record<string, string | undefined>)[id] ?? id;
}

function runtimeRow(status: RuntimeStatus): CheckResult {
  const label = displayName(status.id);
  if (status.effective) {
    return ok(label, `${status.effective.version}  ${status.effective.path}`);
  }
  const finding = status.findings[0];
  if (finding) {
    const severity = findingSeverity(finding);
    const detail = renderFinding(finding);
    return severity === 'fail' ? fail(label, detail) : warn(label, detail);
  }
  const health = runtimeHealthToCheckStatus(status.health);
  return health === 'fail'
    ? fail(label, 'not detected')
    : health === 'warn'
      ? warn(label, 'needs attention')
      : ok(label, 'detected');
}

function versionManagerRow(status: VersionManagerStatus): CheckResult {
  const label = displayName(status.id);
  if (!status.installed) {
    const finding = status.findings[0];
    if (finding) {
      const severity = findingSeverity(finding);
      const detail = renderFinding(finding);
      return severity === 'fail' ? fail(label, detail) : warn(label, detail);
    }
    return warn(label, 'not installed');
  }
  const version = status.managerVersion ?? 'installed';
  const managed = status.versions.length;
  const detail =
    managed > 0 ? `${version}  ${managed} version${managed === 1 ? '' : 's'} managed` : version;
  const worst = status.findings.reduce<CheckResult['status']>((current, finding) => {
    const next = findingSeverity(finding);
    if (next === 'fail') return 'fail';
    if (next === 'warn' && current === 'ok') return 'warn';
    return current;
  }, 'ok');
  if (worst === 'fail') {
    return fail(label, status.findings.map((f) => renderFinding(f)).join('; '));
  }
  if (worst === 'warn') {
    return warn(label, status.findings.map((f) => renderFinding(f)).join('; ') || detail);
  }
  return ok(label, detail);
}

function agentRow(status: AgentCliStatus): CheckResult {
  const label = displayName(status.targetId);
  if (status.effective) {
    return ok(label, `${status.effective.version}  ${status.effective.path}`);
  }
  const finding = status.findings[0];
  if (finding) {
    const severity = findingSeverity(finding);
    const detail = renderFinding(finding);
    return severity === 'fail' ? fail(label, detail) : warn(label, detail);
  }
  return fail(label, 'not installed');
}

export async function collectEnvironmentDoctorSection(
  deps: Partial<EnvironmentDoctorDeps> = {}
): Promise<CheckResult[]> {
  const d = resolveDeps(deps);
  const [runtimes, versionManagers, agents] = await Promise.all([
    d.listRuntimes(),
    d.listVersionManagers(),
    d.listAgents(),
  ]);

  const rows: CheckResult[] = [];
  for (const runtime of runtimes) {
    if (runtime.id === 'mangostudio') continue;
    rows.push(runtimeRow(runtime));
  }
  for (const manager of versionManagers) {
    rows.push(versionManagerRow(manager));
  }
  for (const agent of agents) {
    rows.push(agentRow(agent));
  }
  return rows;
}

function resolveDeps(deps: Partial<EnvironmentDoctorDeps>): EnvironmentDoctorDeps {
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
  };
}
