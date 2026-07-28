import { describe, expect, it } from 'bun:test';
import type { VersionManagerStatus } from '@mangostudio/shared/environments';
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
      listRuntimes: async () => [],
      listVersionManagers: async () => [
        manager('nvm'),
        manager('fnm', { installed: false }),
        manager('volta'),
      ],
      listAgents: async () => [],
    });

    const labels = rows.map((row) => row.label);
    expect(labels).toContain('nvm');
    expect(labels).toContain('fnm');
    expect(labels).toContain('Volta');
  });
});
