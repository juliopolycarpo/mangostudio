/**
 * Shared fixtures for the environments UI tests.
 */

import type {
  AgentCliStatus,
  InstallRecipePreview,
  RuntimeInstallation,
  RuntimeStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';

export function installation(
  overrides: Partial<RuntimeInstallation> & Pick<RuntimeInstallation, 'path' | 'version'>
): RuntimeInstallation {
  return {
    rawPath: overrides.path,
    origin: 'path',
    effective: false,
    ...overrides,
  };
}

export function runtimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    id: 'node',
    health: 'ok',
    installations: [],
    findings: [],
    installable: true,
    probedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function versionManagerStatus(
  overrides: Partial<VersionManagerStatus> = {}
): VersionManagerStatus {
  return {
    id: 'nvm',
    installed: true,
    versions: [],
    findings: [],
    ...overrides,
  };
}

export function agentCliStatus(overrides: Partial<AgentCliStatus> = {}): AgentCliStatus {
  return {
    id: 'claude',
    targetId: 'claude',
    health: 'ok',
    installations: [],
    findings: [],
    installable: true,
    probedAtMs: 1_700_000_000_000,
    configHome: '/home/dev/.claude',
    configHomeExists: true,
    authenticated: false,
    authSignal: 'unknown',
    locations: [],
    ...overrides,
  };
}

export function installRecipe(overrides: Partial<InstallRecipePreview> = {}): InstallRecipePreview {
  return {
    id: 'bun.install.official',
    runtimeId: 'bun',
    action: 'install',
    inputKind: 'none',
    platforms: ['linux', 'darwin'],
    argv: ['bash', '/tmp/installer.sh'],
    copyCommand: 'curl -fsSL https://bun.com/install | bash',
    requires: [],
    writes: ['$HOME/.bun'],
    networkAccess: true,
    timeoutMs: 300_000,
    supported: true,
    missingRequirements: [],
    guard: { allowed: true, reasons: [] },
    ...overrides,
  };
}
