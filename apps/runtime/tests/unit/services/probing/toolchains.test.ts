import { describe, expect, it } from 'bun:test';
import type {
  BinaryScanDeps,
  FnmDetectionDeps,
  NvmDetectionDeps,
  WingetOwnership,
} from '@mangostudio/shared/environments/detection';
import {
  FNM_RUNTIME_DEFINITION,
  NODE_RUNTIME_DEFINITION,
} from '@mangostudio/shared/environments/detection';
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

function missingFnmDeps(): FnmDetectionDeps {
  return {
    ...LINUX_ENV,
    fs: {
      pathExists: () => false,
      readDirectory: () => Promise.resolve([]),
      realpath: (path) => Promise.resolve(path),
    },
  };
}

/** A root that exists but has installed nothing yet — enough for `installed: true` with an empty list. */
function installedEmptyFnmDeps(root = '/home/tester/.local/share/fnm'): FnmDetectionDeps {
  return {
    ...LINUX_ENV,
    fs: {
      pathExists: (path) => path === root,
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

const fnmOnly = {
  ...FNM_RUNTIME_DEFINITION,
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

  it('refuses a runtime probe cancelled after its scan finished but while winget was still in flight', async () => {
    // The scan settles immediately; the abort fires only once winget resolves,
    // well after `scanRuntimeDefinition`'s own `throwIfAborted` already ran
    // clean. Without a check after the two settle together, this would return
    // normal-looking statuses for a call the caller already gave up on.
    const controller = new AbortController();
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
      wingetOwnership: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            controller.abort();
            resolve('unknown');
          }, 5);
        }),
    });

    await expect(service.probeRuntimes({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
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

    const { statuses } = await service.probeVersionManagers({ ids: ['nvm'] });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: 'nvm', installed: false });
  });

  it('detects fnm and reads the current Node from the same scan the tab shows', async () => {
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
      createFnmDeps: missingFnmDeps,
      now: () => Date.parse('2026-07-26T12:00:00.000Z'),
    });

    const { statuses } = await service.probeVersionManagers({ ids: ['fnm'] });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: 'fnm', installed: false });
  });

  it('answers both nvm and fnm when the caller does not narrow the request', async () => {
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: () => scanDeps(),
      createNvmDeps: missingNvmDeps,
      createFnmDeps: missingFnmDeps,
    });

    const { statuses } = await service.probeVersionManagers({});

    expect(statuses.map((status) => status.id).sort()).toEqual(['fnm', 'nvm']);
  });

  it('reuses the fnm runtime scan for the version manager’s own version instead of asking again', async () => {
    let fnmScans = 0;
    const service = createProbingService({
      runtimeDefinitions: [nodeOnly, fnmOnly],
      createPathEnv: () => LINUX_ENV,
      createScanDeps: (_env, definition) => {
        if (definition.id === 'fnm') fnmScans += 1;
        return scanDeps({
          probeVersion: () => Promise.resolve(definition.id === 'fnm' ? 'fnm 1.38.1' : 'v22.13.0'),
        });
      },
      createFnmDeps: () => installedEmptyFnmDeps(),
    });

    const { statuses } = await service.probeVersionManagers({ ids: ['fnm'] });

    expect(statuses[0]).toMatchObject({ id: 'fnm', installed: true, managerVersion: '1.38.1' });
    // One scan for fnm's own binary, not a second spawn from inside detectFnm.
    expect(fnmScans).toBe(1);
  });

  it('answers nothing for a manager this release does not detect', async () => {
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

    const { statuses } = await service.probeVersionManagers({ ids: ['volta'] });

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

    await expect(
      service.probeVersionManagers({ ids: ['nvm'] }, controller.signal)
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
