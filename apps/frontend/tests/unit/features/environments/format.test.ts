/**
 * Presentation rules that hold regardless of what the API returns first.
 */

import { describe, expect, it } from 'bun:test';
import type { RuntimeFinding, RuntimeInstallation } from '@mangostudio/shared/environments';
import { en, ptBR } from '@mangostudio/shared/i18n';
import {
  describeFinding,
  findInstallRecipe,
  findingSeverity,
  formatBytes,
  formatDuration,
  groupInstallations,
  healthRollup,
  type IdentityResolver,
  keyedFindings,
  nodeInstallStep,
  nodeUpdateAffordance,
  pathPosition,
  pathSourceLabel,
  prefixedVersionLabel,
  toolchainProcessLine,
  toolchainSummary,
  versionLabel,
  worstFinding,
} from '../../../../src/features/environments/format';
import { agentCliStatus, installation, installRecipe, runtimeStatus } from './fixtures';

/**
 * `pathSourceManagerName` only reaches the identity registry for `volta`;
 * every other source reads the product dictionary directly. This fake only
 * needs to answer that one case plausibly.
 */
const identityResolver: IdentityResolver = (_kind, id) => ({
  subjectKey: id,
  name: id === 'volta' ? 'Volta' : id,
  monogram: id.slice(0, 2).toUpperCase(),
  image: null,
  storedName: null,
  storedMonogram: null,
  storedImage: null,
  customized: false,
});

describe('groupInstallations', () => {
  it('puts the effective binary first even when it is last in the array', () => {
    const groups = groupInstallations([
      installation({ path: '/usr/bin/node', version: '18.19.0', pathIndex: 3 }),
      installation({ path: '/usr/local/bin/node', version: '20.11.0', pathIndex: 2 }),
      installation({
        path: '/opt/node/bin/node',
        version: '22.13.0',
        pathIndex: 5,
        effective: true,
      }),
    ]);

    expect(groups[0]?.canonical.version).toBe('22.13.0');
    expect(groups.slice(1).map((group) => group.canonical.pathIndex)).toEqual([2, 3]);
  });

  it('sorts installations outside PATH last', () => {
    const groups = groupInstallations([
      installation({ path: '/opt/node/bin/node', version: '22.0.0', origin: 'well-known' }),
      installation({ path: '/usr/bin/node', version: '18.19.0', pathIndex: 0 }),
    ]);

    expect(groups.map((group) => group.canonical.version)).toEqual(['18.19.0', '22.0.0']);
  });

  it('collapses aliases and counts the paths that reach the binary', () => {
    const groups = groupInstallations([
      installation({ path: '/opt/node/bin/node', version: '22.13.0', pathIndex: 0 }),
      installation({
        path: '/opt/node/bin/node',
        rawPath: '/usr/local/bin/node',
        version: '22.13.0',
        pathIndex: 1,
        aliasOf: '/opt/node/bin/node',
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.aliasCount).toBe(2);
    expect(groups[0]?.canonical.rawPath).toBe('/opt/node/bin/node');
  });
});

describe('describeFinding', () => {
  it('states the consequence with one-based PATH positions', () => {
    const finding: RuntimeFinding = {
      code: 'shadowed-by-earlier-path',
      params: {
        effectivePath: '/home/dev/.nvm/versions/node/v22.13.0/bin/node',
        effectivePathIndex: '1',
        shadowedPath: '/usr/local/bin/node',
        shadowedPathIndex: '0',
      },
    };

    expect(describeFinding(en, finding)).toBe(
      'Typing the command runs /usr/local/bin/node (PATH #1), not /home/dev/.nvm/versions/node/v22.13.0/bin/node (PATH #2).'
    );
  });

  it('resolves identifier params to product names', () => {
    expect(describeFinding(en, { code: 'not-found', params: { runtime: 'node' } })).toContain(
      'Node.js'
    );
    expect(
      describeFinding(en, { code: 'cli-not-installed', params: { targetId: 'claude' } })
    ).toContain('Claude Code');
  });

  it('translates a nested LTS status rather than leaking its code', () => {
    const message = describeFinding(en, {
      code: 'outdated-lts',
      params: { version: '20.11.0', ltsStatus: 'lts-superseded' },
    });

    expect(message).toContain('superseded LTS');
    expect(message).not.toContain('lts-superseded');
  });

  it('has a sentence for every finding code in both locales', () => {
    for (const code of Object.keys(en.environments.findings)) {
      expect(ptBR.environments.findings[code as RuntimeFinding['code']]).toBeTruthy();
    }
  });
});

describe('keyedFindings', () => {
  it('keeps identical repeated findings distinct', () => {
    const findings: RuntimeFinding[] = [
      { code: 'not-executable', params: { path: '/usr/bin/node' } },
      { code: 'not-executable', params: { path: '/usr/bin/node' } },
      { code: 'not-executable', params: { path: '/opt/bin/node' } },
    ];

    const keys = keyedFindings(findings).map((entry) => entry.key);

    expect(new Set(keys).size).toBe(3);
  });
});

describe('findingSeverity', () => {
  it('demotes a finding the analyzer marked informational', () => {
    // A stale install below the floor, or a floor belonging to a disabled
    // consumer: the analyzer kept health `ok`, so the row must not read as a
    // failure underneath a green badge.
    expect(
      findingSeverity({
        code: 'version-below-minimum',
        params: { path: '/old/bin/node', version: 'v18.20.0', minimumVersion: '22.13' },
        severity: 'info',
      })
    ).toBe('warn');
  });

  it('still fails the same finding about the binary that actually runs', () => {
    expect(
      findingSeverity({
        code: 'version-below-minimum',
        params: { path: '/usr/bin/node', version: 'v18.20.0', minimumVersion: '22.13' },
      })
    ).toBe('fail');
  });
});

describe('versionLabel', () => {
  it('names an unreadable version instead of rendering nothing', () => {
    expect(versionLabel(en, null)).toBe(en.environments.versionUnknown);
    expect(versionLabel(en, 'v22.13.0')).toBe('v22.13.0');
  });
});

describe('prefixedVersionLabel', () => {
  it('does not stack Version onto the unknown-version phrase', () => {
    expect(prefixedVersionLabel(en, null)).toBe(en.environments.versionUnknown);
    expect(prefixedVersionLabel(ptBR, null)).toBe(ptBR.environments.versionUnknown);
  });

  it('keeps the field label in front of a parsed version', () => {
    expect(prefixedVersionLabel(en, '1.2.3')).toBe(`${en.environments.agents.versionLabel} 1.2.3`);
  });
});

describe('worstFinding', () => {
  it('picks the failure over the warnings whatever order they arrived in', () => {
    const finding = worstFinding([
      { code: 'multiple-versions', params: { runtime: 'node', versions: '18, 22' } },
      { code: 'not-found', params: { runtime: 'node' } },
      { code: 'outdated-lts', params: { version: '18.19.0', ltsStatus: 'lts-superseded' } },
    ]);

    expect(finding?.code).toBe('not-found');
  });

  it('keeps the first of several equals, so the card does not reshuffle', () => {
    const finding = worstFinding([
      { code: 'outdated-lts', params: { version: '18.19.0', ltsStatus: 'lts-superseded' } },
      { code: 'multiple-versions', params: { runtime: 'node', versions: '18, 22' } },
    ]);

    expect(finding?.code).toBe('outdated-lts');
  });

  it('has nothing to lead with when nothing is wrong', () => {
    expect(worstFinding([])).toBeUndefined();
  });
});

describe('healthRollup', () => {
  it('counts every state across the lists it is given', () => {
    const counts = healthRollup([
      [runtimeStatus({ id: 'bun' }), runtimeStatus({ id: 'node', health: 'warn' })],
      [agentCliStatus({ health: 'missing' }), agentCliStatus({ health: 'error' })],
    ]);

    expect(counts).toEqual({ ok: 1, warn: 1, missing: 1, error: 1 });
  });

  it('reports zeros rather than absent keys for an empty machine', () => {
    expect(healthRollup([[], []])).toEqual({ ok: 0, warn: 0, missing: 0, error: 0 });
  });
});

describe('formatting helpers', () => {
  it('renders PATH positions one-based', () => {
    expect(pathPosition(0)).toBe(1);
  });

  it('formats installer sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
  });

  it('formats install durations', () => {
    expect(formatDuration(1500)).toBe('2s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
});

describe('findInstallRecipe', () => {
  it('prefers the supported entry when the catalog lists one per platform', () => {
    const recipes = [
      installRecipe({
        id: 'nvm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        platforms: ['darwin', 'linux'],
        supported: false,
      }),
      installRecipe({
        id: 'fnm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        platforms: ['darwin', 'linux', 'win32'],
        supported: true,
      }),
    ];

    expect(findInstallRecipe(recipes, 'node', 'use-version')?.id).toBe('fnm.node.install');
  });

  it('falls back to the only match when nothing on offer is supported here', () => {
    const recipes = [
      installRecipe({
        id: 'git.install.windows',
        runtimeId: 'git',
        action: 'install',
        platforms: ['win32'],
        supported: false,
      }),
    ];

    expect(findInstallRecipe(recipes, 'git', 'install')?.id).toBe('git.install.windows');
  });

  it('is undefined when the catalog offers nothing for this runtime and action', () => {
    expect(findInstallRecipe([], 'node', 'install')).toBeUndefined();
  });
});

describe('nodeInstallStep', () => {
  it('picks nvm first when it and fnm both offer a fresh install', () => {
    const recipes = [
      installRecipe({
        id: 'nvm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        supported: true,
      }),
      installRecipe({
        id: 'fnm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        supported: true,
      }),
    ];

    const step = nodeInstallStep(recipes);

    expect(step?.recipe.id).toBe('nvm.node.install');
    expect(step?.input).toEqual({ kind: 'node-version', version: 'lts' });
  });

  it('falls back to winget, with no version input, when it is the only one supported here', () => {
    const recipes = [
      installRecipe({
        id: 'nvm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        platforms: ['darwin', 'linux'],
        supported: false,
      }),
      installRecipe({
        id: 'winget.node.install',
        runtimeId: 'node',
        action: 'install',
        inputKind: 'none',
        platforms: ['win32'],
        supported: true,
      }),
    ];

    const step = nodeInstallStep(recipes);

    expect(step?.recipe.id).toBe('winget.node.install');
    expect(step?.input).toEqual({ kind: 'none' });
  });

  // `supported` is decided by platform alone, so a fresh Windows machine has
  // fnm supported whether or not fnm is installed. Preferring it there would
  // expand the documented one-step Windows default into the three-step fnm
  // chain, which is the fallback, not the default.
  it('prefers winget over fnm on a Windows catalog, where both are supported', () => {
    const recipes = [
      installRecipe({
        id: 'nvm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        platforms: ['darwin', 'linux'],
        supported: false,
      }),
      installRecipe({
        id: 'fnm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        supported: true,
      }),
      installRecipe({
        id: 'winget.node.install',
        runtimeId: 'node',
        action: 'install',
        inputKind: 'none',
        platforms: ['win32'],
        supported: true,
      }),
    ];

    const step = nodeInstallStep(recipes);

    expect(step?.recipe.id).toBe('winget.node.install');
    expect(step?.input).toEqual({ kind: 'none' });
  });

  // winget is Windows-only, so on a machine without it the fnm chain is what
  // is left — reordering must not cost the fallback.
  it('falls back to fnm when winget is not supported here', () => {
    const recipes = [
      installRecipe({
        id: 'fnm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
        supported: true,
      }),
      installRecipe({
        id: 'winget.node.install',
        runtimeId: 'node',
        action: 'install',
        inputKind: 'none',
        platforms: ['win32'],
        supported: false,
      }),
    ];

    const step = nodeInstallStep(recipes);

    expect(step?.recipe.id).toBe('fnm.node.install');
    expect(step?.input).toEqual({ kind: 'node-version', version: 'lts' });
  });

  it('is undefined when nothing here installs a fresh Node', () => {
    expect(nodeInstallStep([])).toBeUndefined();
  });
});

describe('nodeUpdateAffordance', () => {
  const NVM_INSTALL = installRecipe({
    id: 'nvm.node.install',
    runtimeId: 'node',
    action: 'use-version',
    inputKind: 'node-version',
  });
  const NVM_SET_DEFAULT = installRecipe({
    id: 'nvm.node.set-default',
    runtimeId: 'node',
    action: 'set-default',
    inputKind: 'node-version',
  });
  const FNM_INSTALL = installRecipe({
    id: 'fnm.node.install',
    runtimeId: 'node',
    action: 'use-version',
    inputKind: 'node-version',
  });
  const FNM_SET_DEFAULT = installRecipe({
    id: 'fnm.node.set-default',
    runtimeId: 'node',
    action: 'set-default',
    inputKind: 'node-version',
  });
  const WINGET_UPDATE = installRecipe({
    id: 'winget.node.update',
    runtimeId: 'node',
    action: 'update',
    inputKind: 'none',
  });
  const CATALOG = [NVM_INSTALL, NVM_SET_DEFAULT, FNM_INSTALL, FNM_SET_DEFAULT, WINGET_UPDATE];

  function effectiveNode(pathSource: RuntimeInstallation['pathSource']) {
    return runtimeStatus({
      id: 'node',
      installations: [
        installation({
          path: '/bin/node',
          version: '20.11.0',
          effective: true,
          ...(pathSource && { pathSource }),
        }),
      ],
    });
  }

  it('chains install then set-default for an nvm-managed Node', () => {
    const affordance = nodeUpdateAffordance(effectiveNode('nvm'), CATALOG);

    if (affordance.kind !== 'steps') throw new Error(`expected steps, got ${affordance.kind}`);
    expect(affordance.primary.recipe.id).toBe('nvm.node.install');
    expect(affordance.primary.input).toEqual({ kind: 'node-version', version: 'lts' });
    expect(affordance.followUp.map((step) => step.recipe.id)).toEqual(['nvm.node.set-default']);
  });

  it('chains install then set-default for an fnm-managed Node', () => {
    const affordance = nodeUpdateAffordance(effectiveNode('fnm'), CATALOG);

    if (affordance.kind !== 'steps') throw new Error(`expected steps, got ${affordance.kind}`);
    expect(affordance.primary.recipe.id).toBe('fnm.node.install');
    expect(affordance.followUp.map((step) => step.recipe.id)).toEqual(['fnm.node.set-default']);
  });

  it('offers the single winget update for a winget-managed Node, with no follow-up', () => {
    const affordance = nodeUpdateAffordance(effectiveNode('winget'), CATALOG);

    if (affordance.kind !== 'steps') throw new Error(`expected steps, got ${affordance.kind}`);
    expect(affordance.primary.recipe.id).toBe('winget.node.update');
    expect(affordance.followUp).toEqual([]);
  });

  it('reports managed-elsewhere for a Volta-managed Node', () => {
    expect(nodeUpdateAffordance(effectiveNode('volta'), CATALOG)).toEqual({
      kind: 'managed-elsewhere',
      source: 'volta',
    });
  });

  it('reports managed-elsewhere, defaulting to system, when no manager is recorded', () => {
    expect(nodeUpdateAffordance(effectiveNode(undefined), CATALOG)).toEqual({
      kind: 'managed-elsewhere',
      source: 'system',
    });
  });

  it('is none when there is no effective installation to update', () => {
    const status = runtimeStatus({ id: 'node', installations: [] });
    expect(nodeUpdateAffordance(status, CATALOG)).toEqual({ kind: 'none' });
  });
});

describe('pathSourceLabel', () => {
  it('reads the source dictionary and defaults an absent source to system', () => {
    expect(pathSourceLabel(en, 'nvm')).toBe('from nvm');
    expect(pathSourceLabel(en, 'volta')).toBe('from Volta');
    expect(pathSourceLabel(en, undefined)).toBe('system install');
  });

  it('has an entry for every source in both locales', () => {
    for (const source of Object.keys(en.environments.pathSources)) {
      expect(
        ptBR.environments.pathSources[source as keyof typeof ptBR.environments.pathSources]
      ).toBeTruthy();
    }
  });
});

describe('toolchainProcessLine', () => {
  function nvmManagedNode() {
    return runtimeStatus({
      id: 'node',
      installations: [
        installation({
          path: '/home/dev/.nvm/versions/node/v20/bin/node',
          version: '20.11.0',
          effective: true,
          pathSource: 'nvm',
        }),
      ],
    });
  }

  it('names the manager on auto, asserted as the full sentence so a doubled preposition cannot hide in a substring match', () => {
    expect(toolchainProcessLine(en, identityResolver, nvmManagedNode(), 'auto')).toBe(
      'Processes run the automatic choice: 20.11.0 from nvm.'
    );
  });

  it('renders the pt-BR sentence for the same named-source case', () => {
    expect(toolchainProcessLine(ptBR, identityResolver, nvmManagedNode(), 'auto')).toBe(
      'Os processos rodam a escolha automática: 20.11.0 via nvm.'
    );
  });

  it('reads its own sentence for a plain system install on auto, never "from the system"', () => {
    const status = runtimeStatus({
      id: 'node',
      installations: [installation({ path: '/usr/bin/node', version: '20.11.0', effective: true })],
    });

    expect(toolchainProcessLine(en, identityResolver, status, 'auto')).toBe(
      'Processes run the automatic choice: 20.11.0, a system install.'
    );
  });

  it('has nothing to say on auto when nothing is effective', () => {
    const status = runtimeStatus({ id: 'node', installations: [] });
    expect(toolchainProcessLine(en, identityResolver, status, 'auto')).toBeUndefined();
  });

  it('names the pinned installation, not the effective one, when they differ', () => {
    const status = runtimeStatus({
      id: 'node',
      installations: [
        installation({ path: '/opt/node/bin/node', version: '18.19.0' }),
        installation({
          path: '/home/dev/.nvm/versions/node/v20/bin/node',
          version: '20.11.0',
          effective: true,
          pathSource: 'nvm',
        }),
      ],
    });

    expect(toolchainProcessLine(en, identityResolver, status, '/opt/node/bin/node')).toBe(
      'Processes run 18.19.0 from /opt/node/bin/node.'
    );
  });

  it('still names a pinned path once its installation drops out of the latest probe', () => {
    const status = runtimeStatus({ id: 'node', installations: [] });

    expect(toolchainProcessLine(en, identityResolver, status, '/opt/node/bin/node')).toBe(
      'Processes run unknown version from /opt/node/bin/node.'
    );
  });
});

describe('toolchainSummary', () => {
  it('is undefined while runtime statuses have not loaded', () => {
    expect(toolchainSummary(en, undefined)).toBeUndefined();
  });

  it('reads both runtimes once loaded', () => {
    const statuses = [
      runtimeStatus({
        id: 'node',
        installations: [
          installation({
            path: '/home/dev/.nvm/versions/node/v20/bin/node',
            version: '20.11.0',
            effective: true,
            pathSource: 'nvm',
          }),
        ],
      }),
      runtimeStatus({
        id: 'bun',
        installations: [
          installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14', effective: true }),
        ],
      }),
    ];

    expect(toolchainSummary(en, statuses)).toBe('Node 20.11.0 (from nvm) · Bun 1.3.14');
  });

  it('names a runtime with no effective installation as not installed instead of dropping it', () => {
    const statuses = [
      runtimeStatus({ id: 'node', installations: [] }),
      runtimeStatus({
        id: 'bun',
        installations: [
          installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14', effective: true }),
        ],
      }),
    ];

    expect(toolchainSummary(en, statuses)).toBe('Node not installed · Bun 1.3.14');
  });
});
