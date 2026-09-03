/**
 * buildSetupRows: the pure rule behind the Overview's Setup checklist — a
 * status per row, and the remedy structurally shaped for whatever fixes it.
 */

import { describe, expect, it } from 'bun:test';
import type {
  AgentCliStatus,
  InstallRecipePreview,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import type { MachineStatus } from '@mangostudio/shared/machine';
import { buildSetupRows } from '../../../../src/features/environments/setup-checklist';
import { agentCliStatus, installation, installRecipe, runtimeStatus } from './fixtures';

const GIT_WIN_RECIPE = installRecipe({
  id: 'git.install.windows',
  runtimeId: 'git',
  action: 'install',
  platforms: ['win32'],
});
const NVM_NODE_INSTALL = installRecipe({
  id: 'nvm.node.install',
  runtimeId: 'node',
  action: 'use-version',
  inputKind: 'node-version',
});
const NVM_NODE_SET_DEFAULT = installRecipe({
  id: 'nvm.node.set-default',
  runtimeId: 'node',
  action: 'set-default',
  inputKind: 'node-version',
});

function machineStatus(overrides: Partial<MachineStatus> = {}): MachineStatus {
  return {
    hub: { running: true },
    service: {
      schemaVersion: 1,
      platform: 'linux',
      unitName: 'mangostudio.service',
      installed: false,
      enabled: false,
      running: false,
    },
    runtimeBinary: { path: null, present: false, version: null, versionMatches: null, error: null },
    hostSlot: { present: false, profile: 'full', directory: '/tmp', error: null },
    platform: 'linux',
    standalone: true,
    container: false,
    homeDir: '/home/dev',
    logsDir: '/home/dev/.mango/logs',
    configFile: null,
    actions: {
      guard: { allowed: true, reasons: [] },
      restart: { available: true, command: 'mangostudio restart' },
      installService: { available: true, command: 'mangostudio service install' },
      uninstallService: { available: false, command: 'mangostudio service uninstall' },
    },
    ...overrides,
  };
}

function rowFor(
  id: string,
  runtimes: RuntimeStatus[] = [],
  agents: AgentCliStatus[] = [],
  recipes: InstallRecipePreview[] = [],
  machine: MachineStatus | undefined = undefined
) {
  const row = buildSetupRows(en, runtimes, agents, recipes, machine).find(
    (entry) => entry.id === id
  );
  if (!row) throw new Error(`expected a "${id}" row`);
  return row;
}

describe('buildSetupRows — git', () => {
  it('is done, with no remedy, once git has an effective installation', () => {
    const runtimes = [
      runtimeStatus({
        id: 'git',
        installations: [installation({ path: '/usr/bin/git', version: '2.47.0', effective: true })],
      }),
    ];

    const row = rowFor('git', runtimes);

    expect(row.status).toBe('done');
    expect(row.remedy).toEqual({ kind: 'none' });
  });

  it('offers the install recipe on Windows', () => {
    const row = rowFor('git', [], [], [GIT_WIN_RECIPE], machineStatus({ platform: 'win32' }));

    expect(row.status).toBe('todo');
    if (row.remedy.kind !== 'install') throw new Error(`expected install, got ${row.remedy.kind}`);
    expect(row.remedy.step.recipe.id).toBe('git.install.windows');
  });

  it('offers a copyable xcode-select command on macOS', () => {
    const row = rowFor('git', [], [], [], machineStatus({ platform: 'darwin' }));

    expect(row.remedy).toEqual({
      kind: 'copy',
      label: en.environments.overview.setup.gitDarwinRemedy,
      value: 'xcode-select --install',
    });
  });

  it('falls back to the distro package-manager hint on Linux', () => {
    const row = rowFor('git', [], [], [], machineStatus({ platform: 'linux' }));

    expect(row.remedy).toEqual({
      kind: 'text',
      text: en.environments.overview.setup.gitLinuxRemedy,
    });
  });
});

describe('buildSetupRows — node', () => {
  it('is todo with the install chain when nothing is installed yet', () => {
    const row = rowFor('node', [], [], [NVM_NODE_INSTALL]);

    expect(row.status).toBe('todo');
    if (row.remedy.kind !== 'install') throw new Error(`expected install, got ${row.remedy.kind}`);
    expect(row.remedy.step.recipe.id).toBe('nvm.node.install');
    expect(row.remedy.followUp).toBeUndefined();
  });

  it('is done when the effective Node carries no outdated-lts finding', () => {
    const runtimes = [
      runtimeStatus({
        id: 'node',
        installations: [
          installation({ path: '/usr/bin/node', version: '22.13.0', effective: true }),
        ],
      }),
    ];

    expect(rowFor('node', runtimes).status).toBe('done');
  });

  it('is todo, with the update chain, when the effective Node is flagged outdated', () => {
    const runtimes = [
      runtimeStatus({
        id: 'node',
        installations: [
          installation({
            path: '/home/dev/.nvm/versions/node/v18/bin/node',
            version: '18.20.0',
            effective: true,
            pathSource: 'nvm',
          }),
        ],
        findings: [
          { code: 'outdated-lts', params: { version: '18.20.0', ltsStatus: 'end-of-life' } },
        ],
      }),
    ];

    const row = rowFor('node', runtimes, [], [NVM_NODE_INSTALL, NVM_NODE_SET_DEFAULT]);

    expect(row.status).toBe('todo');
    if (row.remedy.kind !== 'install') throw new Error(`expected install, got ${row.remedy.kind}`);
    expect(row.remedy.followUp?.map((step) => step.recipe.id)).toEqual(['nvm.node.set-default']);
  });

  it('does not fail an effective Node over an outdated finding that belongs to a different installation', () => {
    // The severity-'info' case: a stale, non-effective Node also emits
    // `outdated-lts`, but must never drag a healthy effective one to `todo`.
    const runtimes = [
      runtimeStatus({
        id: 'node',
        installations: [
          installation({ path: '/usr/bin/node', version: '22.13.0', effective: true }),
        ],
        findings: [
          {
            code: 'outdated-lts',
            params: { version: '18.20.0', ltsStatus: 'end-of-life' },
            severity: 'info',
          },
        ],
      }),
    ];

    expect(rowFor('node', runtimes).status).toBe('done');
  });
});

describe('buildSetupRows — bun', () => {
  it('is optional either way, done when installed', () => {
    const installed = [
      runtimeStatus({
        id: 'bun',
        installations: [
          installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14', effective: true }),
        ],
      }),
    ];

    expect(rowFor('bun', installed).status).toBe('done');
    expect(rowFor('bun', []).status).toBe('optional');
  });
});

describe('buildSetupRows — agent', () => {
  it('is done only when an agent is both effective and authenticated', () => {
    const signedIn = [
      agentCliStatus({
        effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
        authenticated: true,
      }),
    ];
    const installedNotSignedIn = [
      agentCliStatus({
        effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
        authenticated: false,
      }),
    ];

    expect(rowFor('agent', [], signedIn).status).toBe('done');
    expect(rowFor('agent', [], installedNotSignedIn).status).toBe('todo');

    const row = rowFor('agent', [], installedNotSignedIn);
    expect(row.remedy).toEqual({
      kind: 'link',
      to: '/environments/agents',
      label: expect.any(String),
    });
  });
});

describe('buildSetupRows — hub-service', () => {
  it('is done when the service is installed and running', () => {
    const machine = machineStatus({
      service: {
        schemaVersion: 1,
        platform: 'linux',
        unitName: 'mangostudio.service',
        installed: true,
        enabled: true,
        running: true,
      },
    });

    expect(rowFor('hub-service', [], [], [], machine).status).toBe('done');
  });

  it('is todo with a link to This machine when it is not', () => {
    const row = rowFor('hub-service', [], [], [], machineStatus());

    expect(row.status).toBe('todo');
    expect(row.remedy).toEqual({
      kind: 'link',
      to: '/environments/machine',
      label: expect.any(String),
    });
  });

  it('defaults to todo when the machine query has not resolved yet', () => {
    expect(rowFor('hub-service').status).toBe('todo');
  });
});
