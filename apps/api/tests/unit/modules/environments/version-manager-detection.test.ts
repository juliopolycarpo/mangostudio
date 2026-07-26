import { describe, expect, it } from 'bun:test';
import {
  createVersionManagerDetectionService,
  type VersionManagerDetectionServiceOptions,
} from '../../../../src/modules/environments/application/version-manager-detection';
import type { NvmDetectionDeps } from '../../../../src/modules/environments/domain/nvm';

function missingNvmDeps(): NvmDetectionDeps {
  return {
    platform: 'linux',
    homeDir: '/home/tester',
    env: { PATH: '/usr/bin' },
    fs: {
      pathExists: () => false,
      readFile: () => Promise.reject(new Error('missing')),
      readDirectory: () => Promise.resolve([]),
      realpath: (path) => Promise.resolve(path),
    },
  };
}

function createService(overrides: Partial<VersionManagerDetectionServiceOptions> = {}) {
  let runtimeProbeCount = 0;
  let releaseProbeCount = 0;
  const service = createVersionManagerDetectionService({
    createDeps: missingNvmDeps,
    runtimeService: {
      getRuntimeStatus: () => {
        runtimeProbeCount += 1;
        return Promise.resolve(null);
      },
    },
    loadReleaseMetadata: () => {
      releaseProbeCount += 1;
      return Promise.resolve(null);
    },
    now: () => Date.parse('2026-07-26T12:00:00.000Z'),
    ...overrides,
  });
  return {
    service,
    getRuntimeProbeCount: () => runtimeProbeCount,
    getReleaseProbeCount: () => releaseProbeCount,
  };
}

describe('createVersionManagerDetectionService', () => {
  it('caches nvm detection and force-probes both runtime and release metadata', async () => {
    const { service, getRuntimeProbeCount, getReleaseProbeCount } = createService();

    const listed = await service.listVersionManagerStatuses();
    const cached = await service.getVersionManagerStatus('nvm');
    const forced = await service.getVersionManagerStatus('nvm', { force: true });

    expect(listed[0]?.installed).toBe(false);
    expect(cached?.installed).toBe(false);
    expect(forced?.installed).toBe(false);
    expect(getRuntimeProbeCount()).toBe(2);
    expect(getReleaseProbeCount()).toBe(2);
  });

  it('returns null for reserved managers without probing nvm', async () => {
    let createDepsCount = 0;
    const { service, getRuntimeProbeCount } = createService({
      createDeps: () => {
        createDepsCount += 1;
        return missingNvmDeps();
      },
    });

    expect(await service.getVersionManagerStatus('fnm')).toBeNull();
    expect(await service.getVersionManagerStatus('volta')).toBeNull();
    expect(createDepsCount).toBe(0);
    expect(getRuntimeProbeCount()).toBe(0);
  });

  it('invalidates a cached manager explicitly', async () => {
    const { service, getRuntimeProbeCount } = createService();

    await service.getVersionManagerStatus('nvm');
    service.resetVersionManagerCache('nvm');
    await service.getVersionManagerStatus('nvm');

    expect(getRuntimeProbeCount()).toBe(2);
  });
});
