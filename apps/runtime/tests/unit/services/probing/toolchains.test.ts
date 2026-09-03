import { describe, expect, it } from 'bun:test';
import type {
  BinaryScanDeps,
  NvmDetectionDeps,
  WingetOwnership,
} from '@mangostudio/shared/environments/detection';
import { NODE_RUNTIME_DEFINITION } from '@mangostudio/shared/environments/detection';
import { createProbingService } from '../../../../src/services/probing/service';

const LINUX_ENV = {
  platform: 'linux',
  homeDir: '/home/tester',
  env: { PATH: '/node/bin' },
} as const;

const WIN32_ENV = {
  platform: 'win32',
  homeDir: 'C:\\Users\\tester',
  env: { PATH: 'C:\\Program Files\\nodejs', ProgramFiles: 'C:\\Program Files' },
} as const;

function scanDeps(overrides: Partial<BinaryScanDeps> = {}): BinaryScanDeps {
  return {
    ...LINUX_ENV,
    pathExists: () => true,
    probeVersion: () => Promise.resolve('v22.13.0'),
    realpath: (path) => Promise.resolve(path),
    ...overrides,
  };
}

/** Records every package id it was asked about and answers with one fixed verdict. */
class FakeWingetOwnership {
  readonly calls: string[] = [];

  constructor(private readonly verdict: WingetOwnership) {}

  probe = (packageId: string): Promise<WingetOwnership> => {
    this.calls.push(packageId);
    return Promise.resolve(this.verdict);
  };
}

function missingNvmDeps(): NvmDetectionDeps {
  return {
    ...LINUX_ENV,
    fs: {
      pathExists: () => false,
      readFile: () => Promise.reject(new Error('missing')),
      readDirectory: () => Promise.resolve([]),
      realpath: (path) => Promise.resolve(path),
    },
  };
}

const nodeOnly = {
  ...NODE_RUNTIME_DEFINITION,
  wellKnownDirs: () => [],
  includeBareBinaryNames: false,
};

describe('runtime probing', () => {
  it('answers from this host and takes installability from the caller', async () => {
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
      now: () => 1_700_000_000_000,
    });

    const { statuses } = await service.probeRuntimes({ installable: { node: true } });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      id: 'node',
      health: 'ok',
      installable: true,
      probedAtMs: 1_700_000_000_000,
    });
    expect(statuses[0]?.effective?.rawPath).toBe('/node/bin/node');
  });

  it('reports a runtime with no recipe as not installable rather than guessing', async () => {
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps({ pathExists: () => false }),
    });

    const { statuses } = await service.probeRuntimes({});

    expect(statuses[0]).toMatchObject({ health: 'missing', installable: false });
  });

  it('passes the caller-supplied probe budget down to the scan', async () => {
    let seen: BinaryScanDeps | null = null;
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: (_env, _definition, budget) => {
        seen = scanDeps({
          ...(budget?.probeTimeoutMs !== undefined && { probeTimeoutMs: budget.probeTimeoutMs }),
          ...(budget?.totalTimeoutMs !== undefined && { totalTimeoutMs: budget.totalTimeoutMs }),
        });
        return seen;
      },
    });

    await service.probeRuntimes({ budget: { probeTimeoutMs: 250, totalTimeoutMs: 900 } });

    expect(seen).toMatchObject({ probeTimeoutMs: 250, totalTimeoutMs: 900 });
  });

  it('refuses an id it holds no definition for instead of answering for nothing', async () => {
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
    });

    await expect(service.probeRuntimes({ ids: ['bun'] })).rejects.toThrow(/Unknown runtime id/);
  });

  it('merges the hub-pinned library variables over the host own environment', async () => {
    let seenEnv: Record<string, string | undefined> | null = null;
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: (overrides) => ({
        ...LINUX_ENV,
        env: { ...LINUX_ENV.env, ...overrides?.env },
      }),
      createScanDeps: (env) => {
        seenEnv = { ...env.env };
        return scanDeps({ env: env.env });
      },
    });

    await service.probeRuntimes({ pathEnv: { env: { SKILLS_DIR: '/srv/skills' } } });

    expect(seenEnv).toMatchObject({ PATH: '/node/bin', SKILLS_DIR: '/srv/skills' });
  });

  it('refuses a runtime probe cancelled while a version subprocess is in flight', async () => {
    const controller = new AbortController();
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () =>
        scanDeps({
          probeVersion: () => {
            controller.abort();
            return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
        }),
    });

    await expect(service.probeRuntimes({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('asks winget once on win32 and marks the Program Files Node it owns', async () => {
    const winget = new FakeWingetOwnership('owned');
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => WIN32_ENV,
      createScanDeps: () =>
        scanDeps({
          ...WIN32_ENV,
          pathExists: (path) => path === 'C:\\Program Files\\nodejs\\node.exe',
          probeVersion: (path) =>
            Promise.resolve(path === 'C:\\Program Files\\nodejs\\node.exe' ? 'v22.13.0' : null),
        }),
      wingetOwnership: winget.probe,
    });

    const { statuses } = await service.probeRuntimes({});

    expect(winget.calls).toEqual(['OpenJS.NodeJS.LTS']);
    expect(statuses[0]?.effective).toMatchObject({ pathSource: 'winget' });
  });

  it('leaves pathSource as system when winget answers unknown', async () => {
    const winget = new FakeWingetOwnership('unknown');
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => WIN32_ENV,
      createScanDeps: () =>
        scanDeps({
          ...WIN32_ENV,
          pathExists: (path) => path === 'C:\\Program Files\\nodejs\\node.exe',
          probeVersion: (path) =>
            Promise.resolve(path === 'C:\\Program Files\\nodejs\\node.exe' ? 'v22.13.0' : null),
        }),
      wingetOwnership: winget.probe,
    });

    const { statuses } = await service.probeRuntimes({});

    expect(statuses[0]?.effective).toMatchObject({ pathSource: 'system' });
  });

  it('never calls the winget adapter on linux', async () => {
    const winget = new FakeWingetOwnership('owned');
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
      wingetOwnership: winget.probe,
    });

    await service.probeRuntimes({});

    expect(winget.calls).toEqual([]);
  });
});

describe('version manager probing', () => {
  it('detects nvm and reads the current Node from the same scan the tab shows', async () => {
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
      createNvmDeps: missingNvmDeps,
      now: () => Date.parse('2026-07-26T12:00:00.000Z'),
    });

    const { statuses } = await service.probeVersionManagers({});

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: 'nvm', installed: false });
  });

  it('answers nothing for the managers this release does not detect', async () => {
    let nvmDepsCount = 0;
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
      createNvmDeps: () => {
        nvmDepsCount += 1;
        return missingNvmDeps();
      },
    });

    const { statuses } = await service.probeVersionManagers({ ids: ['fnm', 'volta'] });

    expect(statuses).toEqual([]);
    expect(nvmDepsCount).toBe(0);
  });

  it('refuses a version-manager probe cancelled during detection', async () => {
    const controller = new AbortController();
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps({ pathExists: () => false }),
      createNvmDeps: () => {
        controller.abort();
        return missingNvmDeps();
      },
    });

    await expect(service.probeVersionManagers({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
