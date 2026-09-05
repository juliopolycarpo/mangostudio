import { describe, expect, it } from 'bun:test';
import type { UpgradeReport, UpgradeStreamEvent } from '@mangostudio/shared/updates';
import type { ServerState } from '../../../../src/lib/server-state';
import {
  buildScriptEnv,
  createUpgradeService,
  type UpgradeRunRequest,
  type UpgradeServiceDeps,
} from '../../../../src/modules/updates/application/upgrade-service';
import type { InstallOriginProbe } from '../../../../src/modules/updates/domain/install-origin';
import type { ResolvedDownload } from '../../../../src/modules/updates/domain/resolve-target';
import type {
  RunScript,
  ScriptOutputLine,
  ScriptRun,
} from '../../../../src/modules/updates/infrastructure/run-script';

const CURRENT_VERSION = '0.1.1';
const NEWER_VERSION = '0.1.2';

function linesFrom(items: readonly ScriptOutputLine[]): AsyncIterable<ScriptOutputLine> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<ScriptOutputLine>> => {
          if (index >= items.length) return Promise.resolve({ done: true, value: undefined });
          const value = items[index];
          index += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

interface FakeScript {
  readonly runScript: RunScript;
  readonly calls: { argv: readonly string[]; env: Record<string, string> }[];
}

function fakeRunScript(exitCode: number, lines: readonly ScriptOutputLine[] = []): FakeScript {
  const calls: { argv: readonly string[]; env: Record<string, string> }[] = [];
  const runScript: RunScript = (argv, options): ScriptRun => {
    calls.push({ argv, env: options.env });
    return { lines: linesFrom(lines), exitCode: Promise.resolve(exitCode) };
  };
  return { runScript, calls };
}

function selfManagedProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: `/home/j/.mango/dist/${CURRENT_VERSION}/mangostudio`,
    version: CURRENT_VERSION,
    standalone: true,
    container: false,
    home: '/home/j',
    readFile: (path) =>
      path === '/home/j/.mango/dist/install-origin.json'
        ? JSON.stringify({
            origin: 'installer',
            channel: 'stable',
            version: CURRENT_VERSION,
            previousVersion: '0.1.0',
            binDir: '/home/j/.local/bin',
          })
        : null,
    ...overrides,
  };
}

function npmProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: '/usr/local/lib/node_modules/mangostudio/bin/mangostudio.js',
    version: CURRENT_VERSION,
    standalone: true,
    container: false,
    home: '/home/j',
    readFile: () => null,
    ...overrides,
  };
}

function dockerProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return { ...npmProbe(), execPath: '/usr/local/bin/mangostudio', container: true, ...overrides };
}

function newerTarget(overrides: { readonly version?: string } = {}): ResolvedDownload {
  return {
    kind: 'archive',
    channel: 'stable',
    version: NEWER_VERSION,
    assetName: `mangostudio-${NEWER_VERSION}-linux-x64.tar.gz`,
    url: `https://example.test/mangostudio-${NEWER_VERSION}-linux-x64.tar.gz`,
    verification: 'sha256-sums',
    checksumsUrl: 'https://example.test/SHA256SUMS',
    ...overrides,
  };
}

function detachedState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    pid: 999,
    port: 3001,
    host: 'localhost',
    startedAt: 0,
    logFile: '/home/j/.mango/logs/server-1.log',
    version: CURRENT_VERSION,
    ...overrides,
  };
}

const REQUEST: UpgradeRunRequest = { restart: true };

function baseDeps(overrides: Partial<UpgradeServiceDeps> = {}): Partial<UpgradeServiceDeps> {
  return {
    probe: () => selfManagedProbe(),
    configuredChannel: () => null,
    resolveUpgradeTarget: () => Promise.resolve(newerTarget()),
    downloadVerified: (resolved) =>
      Promise.resolve({
        path: `/staging/${resolved.assetName}`,
        verification: resolved.verification,
      }),
    runScript: fakeRunScript(0).runScript,
    writeTempScript: (directory, kind) => Promise.resolve(`${directory}/install.${kind}`),
    which: () => null,
    mkdir: () => Promise.resolve(),
    removeDir: () => Promise.resolve(),
    spawnDetachedWaiter: () => 4242,
    restartHub: () => Promise.resolve(),
    currentExecutable: () => ({
      argv: ['/home/j/.mango/dist/current/mangostudio'],
      pointer: 'current',
    }),
    readState: () => Promise.resolve(detachedState()),
    now: () => 1_700_000_000_000,
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    getVersion: () => CURRENT_VERSION,
    getBuildInfo: () => ({ gitSha: 'abc1234', gitDirty: false, builtAt: '', buildType: 'release' }),
    platformId: 'linux-x64',
    pid: 4242,
    ...overrides,
  };
}

async function collect(
  service: ReturnType<typeof createUpgradeService>,
  request: UpgradeRunRequest = REQUEST
): Promise<{ report: UpgradeReport; events: UpgradeStreamEvent[] }> {
  const events: UpgradeStreamEvent[] = [];
  const report = await service.run(request, (event) => events.push(event));
  return { report, events };
}

function stages(events: UpgradeStreamEvent[]): string[] {
  return events
    .filter((event) => event.type === 'stage')
    .map((event) => (event as { stage: string }).stage);
}

describe('upgrade-service self-managed', () => {
  it('omits buildSha from the resolve context rather than passing the unstamped-build sentinel', async () => {
    // build-info.ts's own fallback for a build with no BUILD_GIT_SHA is the
    // literal string 'unknown' — never a real hex sha. Passing it through
    // as buildSha would defeat isAlreadyCurrent's sha-prefix compare
    // permanently (it can never match a real sha), rather than falling
    // back to the version compare the way a genuinely absent sha does.
    let capturedContext: { readonly buildSha?: string } | undefined;
    const service = createUpgradeService(
      baseDeps({
        getBuildInfo: () => ({
          gitSha: 'unknown',
          gitDirty: 'unknown',
          builtAt: '',
          buildType: 'release',
        }),
        resolveUpgradeTarget: (_request, context) => {
          capturedContext = context;
          return Promise.resolve(newerTarget());
        },
      })
    );

    await collect(service);

    expect(capturedContext?.buildSha).toBeUndefined();
  });

  it('upgrades, restarts a detached hub, and reports every stage in order', async () => {
    const script = fakeRunScript(0, [{ stream: 'stdout', line: 'Installed MangoStudio 0.1.2' }]);
    const restartCalls: { state: ServerState; launch: string }[] = [];
    const mkdirCalls: string[] = [];
    const removeDirCalls: string[] = [];

    const service = createUpgradeService(
      baseDeps({
        runScript: script.runScript,
        mkdir: (path) => {
          mkdirCalls.push(path);
          return Promise.resolve();
        },
        removeDir: (path) => {
          removeDirCalls.push(path);
          return Promise.resolve();
        },
        restartHub: (input) => {
          restartCalls.push(input);
          return Promise.resolve();
        },
      })
    );

    const { report, events } = await collect(service);

    expect(report.outcome).toBe('upgraded');
    expect(report.exitCode).toBe(0);
    expect(report.restart).toBe('scheduled');
    expect(report.target?.version).toBe(NEWER_VERSION);
    expect(report.currentVersion).toBe(CURRENT_VERSION);
    expect(stages(events)).toEqual(['resolve', 'download', 'verify', 'install', 'restart']);
    expect(events).toContainEqual({
      type: 'output',
      stream: 'stdout',
      line: 'Installed MangoStudio 0.1.2',
      done: false,
    });

    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.argv).toEqual([
      'bash',
      '/home/j/.mango/dist/.staging-0.1.2-4242/install.sh',
      '--local',
      '/staging/mangostudio-0.1.2-linux-x64.tar.gz',
    ]);
    expect(script.calls[0]?.env.MANGOSTUDIO_INSTALL_ORIGIN).toBe('upgrade');
    expect(script.calls[0]?.env.MANGOSTUDIO_INSTALL_DIR).toBe('/home/j/.mango/dist');
    expect(script.calls[0]?.env.MANGOSTUDIO_BIN_DIR).toBe('/home/j/.local/bin');
    expect(script.calls[0]?.env.PATH).toBe('/usr/bin');

    expect(mkdirCalls).toEqual(['/home/j/.mango/dist/.staging-0.1.2-4242']);
    expect(removeDirCalls).toEqual(['/home/j/.mango/dist/.staging-0.1.2-4242']);
    expect(restartCalls).toEqual([{ state: detachedState(), launch: 'detached' }]);
  });

  it('reports already-current without downloading or running anything', async () => {
    let downloadCalled = false;
    const service = createUpgradeService(
      baseDeps({
        resolveUpgradeTarget: () => Promise.resolve(newerTarget({ version: CURRENT_VERSION })),
        downloadVerified: () => {
          downloadCalled = true;
          return Promise.resolve({ path: '/x', verification: 'sha256-sums' });
        },
      })
    );

    const { report, events } = await collect(service);

    expect(report.outcome).toBe('already-current');
    expect(report.exitCode).toBe(0);
    expect(downloadCalled).toBe(false);
    expect(stages(events)).toEqual(['resolve']);
  });

  it('reports already-current for an unpinned "latest" that has fallen behind (a yanked release)', async () => {
    // The release index still names an older version "latest" — 0.1.2 was
    // published then pulled, leaving 0.1.1 (the version already running) as
    // the top of the index again. No `request.version`, so this is not a
    // pin; it must read as nothing to do, not as a downgrade to install.
    let downloadCalled = false;
    const service = createUpgradeService(
      baseDeps({
        resolveUpgradeTarget: () => Promise.resolve(newerTarget({ version: '0.1.0' })),
        downloadVerified: () => {
          downloadCalled = true;
          return Promise.resolve({ path: '/x', verification: 'sha256-sums' });
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('already-current');
    expect(downloadCalled).toBe(false);
  });

  it('installs an explicit older --version pin as the deliberate downgrade it is', async () => {
    const script = fakeRunScript(0);
    const service = createUpgradeService(
      baseDeps({
        resolveUpgradeTarget: () => Promise.resolve(newerTarget({ version: '0.1.0' })),
        runScript: script.runScript,
      })
    );

    const { report } = await collect(service, { restart: false, version: '0.1.0' });

    expect(report.outcome).toBe('upgraded');
    expect(report.target?.version).toBe('0.1.0');
    expect(script.calls).toHaveLength(1);
  });

  it('previews an available update with --check and never downloads', async () => {
    let downloadCalled = false;
    const service = createUpgradeService(
      baseDeps({
        downloadVerified: () => {
          downloadCalled = true;
          return Promise.resolve({ path: '/x', verification: 'sha256-sums' });
        },
      })
    );

    const { report } = await collect(service, { restart: true, checkOnly: true });

    expect(report.outcome).toBe('available');
    expect(report.exitCode).toBe(0);
    expect(report.target?.version).toBe(NEWER_VERSION);
    expect(downloadCalled).toBe(false);
  });

  it('reports not-running when no live hub owns the state file', async () => {
    const service = createUpgradeService(baseDeps({ readState: () => Promise.resolve(null) }));

    const { report } = await collect(service);

    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('not-running');
  });

  it('reports skipped and never restarts when the request declines a restart', async () => {
    let restarted = false;
    const service = createUpgradeService(
      baseDeps({
        restartHub: () => {
          restarted = true;
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service, { restart: false });

    expect(report.restart).toBe('skipped');
    expect(restarted).toBe(false);
  });

  it('reports failed with exit 2 and the exit code when the install script fails', async () => {
    const script = fakeRunScript(7, [{ stream: 'stderr', line: 'boom' }]);
    const removeDirCalls: string[] = [];
    const service = createUpgradeService(
      baseDeps({
        runScript: script.runScript,
        removeDir: (path) => {
          removeDirCalls.push(path);
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(report.exitCode).toBe(2);
    expect(report.message).toContain('7');
    // The staging dir is still removed on a failed script.
    expect(removeDirCalls).toHaveLength(1);
  });

  it('reports failed with exit 2 when the download rejects, and still cleans the staging dir', async () => {
    const removeDirCalls: string[] = [];
    const service = createUpgradeService(
      baseDeps({
        downloadVerified: () =>
          Promise.reject(new Error('checksum mismatch for x.tar.gz: expected a | received b')),
        removeDir: (path) => {
          removeDirCalls.push(path);
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(report.exitCode).toBe(2);
    expect(report.message).toContain('checksum mismatch');
    expect(removeDirCalls).toHaveLength(1);
  });

  it('reports refused when the resolver cannot serve the target', async () => {
    const service = createUpgradeService(
      baseDeps({
        resolveUpgradeTarget: () =>
          Promise.resolve({
            reason: 'unsupported-target',
            message: 'no npm package for this platform',
          }),
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('refused');
    expect(report.reason).toBe('unsupported-target');
    expect(report.exitCode).toBe(1);
  });

  it('appends the versioned-pointer note when the unit still needs reinstalling', async () => {
    const service = createUpgradeService(
      baseDeps({
        currentExecutable: () => ({
          argv: ['/home/j/.mango/dist/0.1.2/mangostudio'],
          pointer: 'versioned',
          note: 'No launcher at .../mangostudio.cmd; run "mangostudio service install" again.',
        }),
      })
    );

    const { report } = await collect(service);

    expect(report.message).toContain('mangostudio service install');
  });

  it('refuses a Windows Scheduled Task restart with the self-restart note', async () => {
    let restarted = false;
    const service = createUpgradeService(
      baseDeps({
        platform: 'win32',
        readState: () => Promise.resolve(detachedState({ logFile: '', service: 'MangoStudio' })),
        restartHub: () => {
          restarted = true;
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.restart).toBe('manual');
    expect(report.message).toContain('Scheduled Task');
    expect(restarted).toBe(false);
  });

  it('still reports the upgrade as successful when the restart effect itself fails', async () => {
    const service = createUpgradeService(
      baseDeps({
        restartHub: () => Promise.reject(new Error('did not stop within 10s')),
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('upgraded');
    expect(report.exitCode).toBe(0);
    expect(report.restart).toBe('manual');
    expect(report.message).toContain('did not stop within 10s');
    expect(report.message).toContain('mangostudio restart');
  });
});

describe('upgrade-service delegate plans', () => {
  it('runs the package manager directly on POSIX and relays its output', async () => {
    const script = fakeRunScript(0, [{ stream: 'stdout', line: 'added 1 package' }]);
    const service = createUpgradeService(
      baseDeps({ probe: () => npmProbe(), runScript: script.runScript })
    );

    const { report, events } = await collect(service);

    expect(report.outcome).toBe('upgraded');
    expect(report.exitCode).toBe(0);
    expect(script.calls[0]?.argv).toEqual(['npm', 'install', '-g', `mangostudio@latest`]);
    expect(stages(events)).toEqual(['resolve', 'install']);
  });

  it('reports failed with exit 2 when the package manager exits non-zero', async () => {
    const script = fakeRunScript(1);
    const service = createUpgradeService(
      baseDeps({ probe: () => npmProbe(), runScript: script.runScript })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(report.exitCode).toBe(2);
  });

  it('refuses to preview a delegate plan with --check, naming the command', async () => {
    let ran = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe(),
        runScript: () => {
          ran = true;
          return { lines: linesFrom([]), exitCode: Promise.resolve(0) };
        },
      })
    );

    const { report } = await collect(service, { restart: true, checkOnly: true });

    expect(report.outcome).toBe('refused');
    expect(report.reason).toBe('package-manager');
    expect(report.command).toBe('npm install -g mangostudio@latest');
    expect(report.exitCode).toBe(1);
    expect(ran).toBe(false);
  });

  it('runs a Windows delegation through the detached waiter instead of in-process', async () => {
    const waiterCalls: { argv: readonly string[]; waitForPid: number; logFile: string }[] = [];
    let ran = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        spawnDetachedWaiter: (input) => {
          waiterCalls.push(input);
          return 1;
        },
        runScript: () => {
          ran = true;
          return { lines: linesFrom([]), exitCode: Promise.resolve(0) };
        },
      })
    );

    const { report } = await collect(service);

    expect(ran).toBe(false);
    expect(waiterCalls).toHaveLength(1);
    expect(waiterCalls[0]?.argv).toEqual(['npm', 'install', '-g', 'mangostudio@latest']);
    expect(waiterCalls[0]?.waitForPid).toBe(555);
    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('skipped');
    expect(report.logFile).toBe(waiterCalls[0]?.logFile);
    expect(report.message).toContain('runs after this process exits');
    expect(report.exitCode).toBe(0);
  });

  it('reports a refused plan verbatim for a manager the hub must not fight', async () => {
    const service = createUpgradeService(baseDeps({ probe: () => dockerProbe() }));

    const { report } = await collect(service);

    expect(report.outcome).toBe('refused');
    expect(report.reason).toBe('container');
    expect(report.command).toContain('docker pull');
    expect(report.exitCode).toBe(1);
  });
});

describe('upgrade-service rollback', () => {
  it('rolls back to the previous version and restarts', async () => {
    const script = fakeRunScript(0);
    const restartCalls: unknown[] = [];
    const service = createUpgradeService(
      baseDeps({
        runScript: script.runScript,
        restartHub: (input) => {
          restartCalls.push(input);
          return Promise.resolve();
        },
      })
    );

    const events: UpgradeStreamEvent[] = [];
    const report = await service.rollback((event) => events.push(event));

    expect(report.outcome).toBe('upgraded');
    expect(report.exitCode).toBe(0);
    expect(report.target).toBeUndefined();
    expect(script.calls[0]?.argv).toEqual([
      'bash',
      '/home/j/.mango/dist/.rollback-0.1.0-4242/install.sh',
      '--use',
      '0.1.0',
    ]);
    expect(restartCalls).toHaveLength(1);
  });

  it('honors restart: false, skipping the restart effect', async () => {
    let restarted = false;
    const service = createUpgradeService(
      baseDeps({
        restartHub: () => {
          restarted = true;
          return Promise.resolve();
        },
      })
    );

    const report = await service.rollback(() => undefined, { restart: false });

    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('skipped');
    expect(restarted).toBe(false);
  });

  it('refuses when no previous version is recorded', async () => {
    const service = createUpgradeService(
      baseDeps({
        probe: () =>
          selfManagedProbe({
            readFile: (path) =>
              path === '/home/j/.mango/dist/install-origin.json'
                ? JSON.stringify({
                    origin: 'installer',
                    channel: 'stable',
                    version: CURRENT_VERSION,
                  })
                : null,
          }),
      })
    );

    const events: UpgradeStreamEvent[] = [];
    const report = await service.rollback((event) => events.push(event));

    expect(report.outcome).toBe('refused');
    expect(report.reason).toBeUndefined();
    expect(report.command).toBeUndefined();
    expect(report.message).toContain('No previous version recorded');
    expect(report.exitCode).toBe(1);
  });

  it('refuses when the install is not self-managed', async () => {
    const service = createUpgradeService(baseDeps({ probe: () => npmProbe() }));

    const report = await service.rollback(() => undefined);

    expect(report.outcome).toBe('refused');
    expect(report.reason).toBe('package-manager');
    expect(report.message).toContain('Rollback only applies');
  });
});

describe('upgrade-service concurrency guard', () => {
  it('refuses a second run() while the first is still downloading, then accepts one once it settles', async () => {
    let resolveDownload: (() => void) | undefined;
    const service = createUpgradeService(
      baseDeps({
        downloadVerified: (resolved) =>
          new Promise((resolve) => {
            resolveDownload = () =>
              resolve({
                path: `/staging/${resolved.assetName}`,
                verification: resolved.verification,
              });
          }),
      })
    );

    const firstEvents: UpgradeStreamEvent[] = [];
    const firstPromise = service.run(REQUEST, (event) => firstEvents.push(event));
    // Let the first call reach the paused download before racing a second one.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondEvents: UpgradeStreamEvent[] = [];
    const secondReport = await service.run(REQUEST, (event) => secondEvents.push(event));
    expect(secondReport).toMatchObject({
      outcome: 'refused',
      reason: 'in-progress',
      command: 'mangostudio status',
    });
    // Refused before ever emitting a stage — it never touched the engine's
    // own work, just this instance's lock.
    expect(secondEvents).toEqual([]);

    resolveDownload?.();
    const firstReport = await firstPromise;
    expect(firstReport.outcome).toBe('upgraded');
    expect(firstEvents.length).toBeGreaterThan(0);

    // The third call downloads again — resolve its own paused download too.
    const thirdPromise = service.run(REQUEST, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveDownload?.();
    const thirdReport = await thirdPromise;
    expect(thirdReport.outcome).toBe('upgraded');
  });

  it('refuses rollback() while a run() on the same instance is still in flight', async () => {
    let resolveDownload: (() => void) | undefined;
    const service = createUpgradeService(
      baseDeps({
        downloadVerified: (resolved) =>
          new Promise((resolve) => {
            resolveDownload = () =>
              resolve({
                path: `/staging/${resolved.assetName}`,
                verification: resolved.verification,
              });
          }),
      })
    );

    const firstPromise = service.run(REQUEST, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rollbackReport = await service.rollback(() => undefined);
    expect(rollbackReport).toMatchObject({ outcome: 'refused', reason: 'in-progress' });

    resolveDownload?.();
    await firstPromise;
  });
});

describe('buildScriptEnv', () => {
  const installedVia = {
    manager: 'self-managed' as const,
    channel: 'stable' as const,
    executable: '/home/j/.mango/dist/current/mangostudio',
    distRoot: '/home/j/.mango/dist',
    record: { origin: 'installer' as const, channel: 'stable' as const, version: '0.1.1' },
  };

  it('carries the Windows system block install.ps1 needs to detect the host architecture and resolve executables', () => {
    // Get-Platform reads PROCESSOR_ARCHITECTURE/PROCESSOR_ARCHITEW6432; the
    // PowerShell 5.1 smoke check ("& $exe '--version'") needs PATHEXT to
    // treat mangostudio.exe as executable. Bun.spawn({ env }) replaces the
    // child's environment, so a key missing here is simply gone for the
    // script's whole run, not merged from this process's own environment.
    const env = buildScriptEnv(
      {
        PATH: 'C:\\Windows\\System32',
        PROCESSOR_ARCHITECTURE: 'AMD64',
        PROCESSOR_ARCHITEW6432: 'AMD64',
        PATHEXT: '.COM;.EXE;.BAT',
        SystemRoot: 'C:\\Windows',
      },
      installedVia
    );

    expect(env.PROCESSOR_ARCHITECTURE).toBe('AMD64');
    expect(env.PROCESSOR_ARCHITEW6432).toBe('AMD64');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT');
    expect(env.SystemRoot).toBe('C:\\Windows');
  });

  it('never forwards a key the source env does not have', () => {
    const env = buildScriptEnv({ PATH: '/usr/bin' }, installedVia);

    expect(env.PROCESSOR_ARCHITECTURE).toBeUndefined();
    expect(env.PATHEXT).toBeUndefined();
  });

  it('always sets MANGOSTUDIO_INSTALL_ORIGIN=upgrade and the dist/bin dir overrides', () => {
    const env = buildScriptEnv(
      { PATH: '/usr/bin' },
      {
        ...installedVia,
        record: { ...installedVia.record, binDir: '/home/j/.local/bin' },
      }
    );

    expect(env.MANGOSTUDIO_INSTALL_ORIGIN).toBe('upgrade');
    expect(env.MANGOSTUDIO_INSTALL_DIR).toBe('/home/j/.mango/dist');
    expect(env.MANGOSTUDIO_BIN_DIR).toBe('/home/j/.local/bin');
  });
});
