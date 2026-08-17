/**
 * Presentation rules that hold regardless of what the API returns first.
 */

import type { RuntimeFinding } from '@mangostudio/shared/environments';
import { en, ptBR } from '@mangostudio/shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  describeFinding,
  findingSeverity,
  formatBytes,
  formatDuration,
  groupInstallations,
  healthRollup,
  keyedFindings,
  pathPosition,
  versionLabel,
  worstFinding,
} from '../../../../src/features/environments/format';
import { agentCliStatus, installation, runtimeStatus } from './fixtures';

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
