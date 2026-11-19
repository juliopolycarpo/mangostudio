/**
 * Environments section for `mango doctor`.
 */

import type {
  AgentCliStatus,
  RuntimeFinding,
  RuntimeStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { environmentDisplayNamesEn } from '@mangostudio/shared/environments';

import {
  environmentProbingService,
  LOCAL_PROBE_SCOPE,
  type ProbeOptions,
} from '../modules/environments/application/probing-service';
import {
  resolveWslExecutable,
  type WslExecutable,
  type WslExecutableSource,
} from '../modules/environments/infrastructure/wsl-executable';
import type { CheckResult } from './doctor-checks';
import { keyedCheck } from './doctor-checks';
import {
  findingParams,
  findingSeverity,
  renderFinding,
  runtimeHealthToCheckStatus,
} from './finding-renderer';

export interface EnvironmentDoctorDeps {
  readonly listRuntimes: (options?: ProbeOptions) => Promise<RuntimeStatus[]>;
  readonly listVersionManagers: (options?: ProbeOptions) => Promise<VersionManagerStatus[]>;
  readonly listAgents: (options?: ProbeOptions) => Promise<AgentCliStatus[]>;
  /** Windows only; the row this produces is skipped everywhere else. */
  readonly platform: NodeJS.Platform;
  readonly resolveWslExecutable: () => WslExecutable;
}

function displayName(id: string): string {
  return (environmentDisplayNamesEn as Record<string, string | undefined>)[id] ?? id;
}

/** The tool's product name, which reads the same in every language, so it is a param. */
function toolParams(id: string): { tool: string } {
  return { tool: displayName(id) };
}

/**
 * A row for one finding. The finding's code is the row's detail key: the
 * sentence for it already exists in the shared findings templates, in every
 * language, and the params are the ones that template reads.
 */
function findingRow(id: string, finding: RuntimeFinding): CheckResult {
  return keyedCheck(findingSeverity(finding), 'env.label.tool', finding.code, {
    ...findingParams(finding),
    ...toolParams(id),
  });
}

/** A row for an installation the probe found: version and where it is. */
function installationRow(
  id: string,
  effective: NonNullable<RuntimeStatus['effective']>
): CheckResult {
  const base = { ...toolParams(id), path: effective.path };
  // A probe can find an install and still fail to read its version; say so
  // in words instead of printing the literal `null`.
  if (effective.version === null) {
    return keyedCheck('ok', 'env.label.tool', 'env.detail.versionUnknownAndPath', base);
  }
  return keyedCheck('ok', 'env.label.tool', 'env.detail.versionAndPath', {
    ...base,
    version: effective.version,
  });
}

function runtimeRow(status: RuntimeStatus): CheckResult {
  if (status.effective) {
    return installationRow(status.id, status.effective);
  }
  const finding = status.findings[0];
  if (finding) {
    return findingRow(status.id, finding);
  }
  const health = runtimeHealthToCheckStatus(status.health);
  const detailKey =
    health === 'fail'
      ? 'env.detail.notDetected'
      : health === 'warn'
        ? 'env.detail.needsAttention'
        : 'env.detail.detected';
  return keyedCheck(health, 'env.label.tool', detailKey, toolParams(status.id));
}

function versionManagerRow(status: VersionManagerStatus): CheckResult {
  if (!status.installed) {
    const finding = status.findings[0];
    return finding
      ? findingRow(status.id, finding)
      : keyedCheck('warn', 'env.label.tool', 'env.detail.notInstalled', toolParams(status.id));
  }

  const worst = status.findings.reduce<CheckResult['status']>((current, finding) => {
    const next = findingSeverity(finding);
    if (next === 'fail') return 'fail';
    if (next === 'warn' && current === 'ok') return 'warn';
    return current;
  }, 'ok');
  if (worst !== 'ok') {
    const [only, ...others] = status.findings;
    if (only && others.length === 0) return findingRow(status.id, only);
    // Several findings share one row; the row joins their English sentences,
    // as the CLI always has, and the page shows that text as it is.
    return keyedCheck(worst, 'env.label.tool', 'env.detail.findingsJoined', {
      ...toolParams(status.id),
      findings: status.findings.map((finding) => renderFinding(finding)).join('; '),
    });
  }

  // One sentence per count shape, since "1 version" and "2 versions" are
  // different words in some languages; only the plural sentence names the count.
  const managed = status.versions.length;
  const managerVersion = status.managerVersion ?? null;
  const base = toolParams(status.id);
  const params = {
    ...base,
    ...(managerVersion === null ? {} : { version: managerVersion }),
    ...(managed > 1 ? { count: managed } : {}),
  };
  if (managerVersion === null) {
    return keyedCheck(
      'ok',
      'env.label.tool',
      managed === 0
        ? 'env.detail.installed'
        : managed === 1
          ? 'env.detail.installedManagedOne'
          : 'env.detail.installedManagedMany',
      params
    );
  }
  return keyedCheck(
    'ok',
    'env.label.tool',
    managed === 0
      ? 'env.detail.managerVersion'
      : managed === 1
        ? 'env.detail.managerVersionManagedOne'
        : 'env.detail.managerVersionManagedMany',
    params
  );
}

function agentRow(status: AgentCliStatus): CheckResult {
  if (status.effective) {
    return installationRow(status.targetId, status.effective);
  }
  const finding = status.findings[0];
  return finding
    ? findingRow(status.targetId, finding)
    : keyedCheck('fail', 'env.label.tool', 'env.detail.notInstalled', toolParams(status.targetId));
}

/**
 * Names which `wsl.exe` a WSL connect would spawn and why, so a support
 * transcript can tell a `program-files` resolution from an `override` without
 * asking the reporter to run PowerShell. Windows only: off Windows nothing
 * calls `wsl.exe`, and the row would just repeat the same PATH fallback.
 */
function wslExecutableRow(executable: WslExecutable): CheckResult {
  const source: WslExecutableSource = executable.source;
  return keyedCheck('ok', 'env.label.wslExecutable', 'env.detail.wslExecutable', {
    path: executable.path,
    // The source is the resolver's own identifier (`override`, `program-files`),
    // the word a support transcript quotes, so it stays as it is in every language.
    source,
  });
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
  if (d.platform === 'win32') {
    rows.push(wslExecutableRow(d.resolveWslExecutable()));
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
    platform: deps.platform ?? process.platform,
    resolveWslExecutable: deps.resolveWslExecutable ?? resolveWslExecutable,
  };
}
