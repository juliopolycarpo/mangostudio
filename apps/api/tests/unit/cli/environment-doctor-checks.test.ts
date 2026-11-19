import { describe, expect, it } from 'bun:test';

import type { RuntimeStatus, VersionManagerStatus } from '@mangostudio/shared/environments';

import { collectEnvironmentDoctorSection } from '../../../src/cli/environment-doctor-checks';

function manager(
  id: VersionManagerStatus['id'],
  overrides: Partial<VersionManagerStatus> = {}
): VersionManagerStatus {
  return {
    id,
    installed: true,
    managerVersion: '1.0.0',
    versions: [],
    findings: [],
    ...overrides,
  };
}

describe('collectEnvironmentDoctorSection', () => {
  it('includes every supported version manager', async () => {
    const rows = await collectEnvironmentDoctorSection({
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      listRuntimes: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      listVersionManagers: async () => [
        manager('nvm'),
        manager('fnm', { installed: false }),
        manager('volta'),
      ],
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      listAgents: async () => [],
    });

    const labels = rows.map((row) => row.label);
    expect(labels).toContain('nvm');
    expect(labels).toContain('fnm');
    expect(labels).toContain('Volta');
  });

  it('names a missing version manager in its not-found row', async () => {
    const rows = await collectEnvironmentDoctorSection({
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      listRuntimes: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      listVersionManagers: async () => [
        manager('fnm', {
          installed: false,
          findings: [{ code: 'not-found', params: { manager: 'fnm' } }],
        }),
      ],
      // eslint-disable-next-line @typescript-eslint/require-await -- The test double preserves its Promise-returning interface contract.
      listAgents: async () => [],
    });

    const row = rows.find((candidate) => candidate.label === 'fnm');
    expect(row?.detail).toBe('fnm was not found on PATH or in any well-known location.');
  });

  it('keys an install with no version by its own detail key, with no version param', async () => {
    const rows = await collectEnvironmentDoctorSection({
      listRuntimes: () =>
        Promise.resolve([
          {
            id: 'bun',
            health: 'ok',
            effective: {
              path: '/usr/bin/bun',
              rawPath: '/usr/bin/bun',
              version: null,
              origin: 'path',
              effective: true,
            },
            installs: [],
            findings: [],
          } as unknown as RuntimeStatus,
        ]),
      listVersionManagers: () => Promise.resolve([]),
      listAgents: () => Promise.resolve([]),
    });

    const row = rows.find((candidate) => candidate.label === 'Bun');
    expect(
      { detailKey: row?.detailKey, params: row?.params, detail: row?.detail },
      '(row for an install whose version is null)'
    ).toEqual({
      detailKey: 'env.detail.versionUnknownAndPath',
      params: { tool: 'Bun', path: '/usr/bin/bun' },
      detail: 'version unknown  /usr/bin/bun',
    });
  });
});
