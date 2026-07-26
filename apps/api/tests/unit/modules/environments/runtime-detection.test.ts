import { describe, expect, it } from 'bun:test';
import { createRuntimeDetectionService } from '../../../../src/modules/environments/application/runtime-detection';
import type { BinaryScanDeps } from '../../../../src/modules/environments/domain/binary-scan';
import { NODE_RUNTIME_DEFINITION } from '../../../../src/modules/environments/domain/runtime-definitions';

describe('runtime detection cache', () => {
  it('re-scans immediately when PATH changes inside the TTL', async () => {
    let currentPath = '/first/bin';
    let probeCount = 0;
    const definition = {
      ...NODE_RUNTIME_DEFINITION,
      wellKnownDirs: () => [],
      includeBareBinaryNames: false,
    };
    const createDeps = (): BinaryScanDeps => ({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { PATH: currentPath },
      pathExists: () => true,
      probeVersion: (binary) => {
        probeCount += 1;
        return Promise.resolve(binary.startsWith('/first') ? 'v22.13.0' : 'v23.1.0');
      },
      realpath: (path) => Promise.resolve(path),
    });
    const service = createRuntimeDetectionService({
      definitions: [definition],
      createDeps,
      now: () => 1_700_000_000_000,
    });

    const first = await service.getRuntimeStatus('node');
    const cached = await service.getRuntimeStatus('node');
    currentPath = '/second/bin';
    const changed = await service.getRuntimeStatus('node');

    expect(first?.effective?.rawPath).toBe('/first/bin/node');
    expect(cached).toEqual(first);
    expect(changed?.effective).toMatchObject({
      rawPath: '/second/bin/node',
      version: 'v23.1.0',
    });
    expect(probeCount).toBe(2);
  });

  it('deduplicates in-flight scans and honors an explicit force probe', async () => {
    let probeCount = 0;
    let resolveProbe: ((version: string) => void) | undefined;
    const definition = {
      ...NODE_RUNTIME_DEFINITION,
      wellKnownDirs: () => [],
      includeBareBinaryNames: false,
    };
    const createDeps = (): BinaryScanDeps => ({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { PATH: '/node/bin' },
      pathExists: () => true,
      probeVersion: () => {
        probeCount += 1;
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      },
      realpath: (path) => Promise.resolve(path),
    });
    const service = createRuntimeDetectionService({
      definitions: [definition],
      createDeps,
      now: () => 1_700_000_000_000,
    });

    const first = service.getRuntimeStatus('node');
    const concurrent = service.getRuntimeStatus('node');
    await Promise.resolve();
    await Promise.resolve();
    expect(probeCount).toBe(1);
    resolveProbe?.('v22.13.0');
    expect(await concurrent).toEqual(await first);

    const forced = service.getRuntimeStatus('node', { force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(probeCount).toBe(2);
    resolveProbe?.('v23.1.0');
    expect((await forced)?.effective?.version).toBe('v23.1.0');
  });

  it('does not let an older in-flight scan overwrite a forced result', async () => {
    const probeResolvers: Array<(version: string) => void> = [];
    const definition = {
      ...NODE_RUNTIME_DEFINITION,
      wellKnownDirs: () => [],
      includeBareBinaryNames: false,
    };
    const service = createRuntimeDetectionService({
      definitions: [definition],
      createDeps: () => ({
        platform: 'linux',
        homeDir: '/home/tester',
        env: { PATH: '/node/bin' },
        pathExists: () => true,
        probeVersion: () =>
          new Promise((resolve) => {
            probeResolvers.push(resolve);
          }),
        realpath: (path) => Promise.resolve(path),
      }),
      now: () => 1_700_000_000_000,
    });

    const older = service.getRuntimeStatus('node');
    const forced = service.getRuntimeStatus('node', { force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(probeResolvers).toHaveLength(2);

    probeResolvers[1]?.('v23.1.0');
    expect((await forced)?.effective?.version).toBe('v23.1.0');
    probeResolvers[0]?.('v22.13.0');
    await older;

    expect((await service.getRuntimeStatus('node'))?.effective?.version).toBe('v23.1.0');
  });
});
