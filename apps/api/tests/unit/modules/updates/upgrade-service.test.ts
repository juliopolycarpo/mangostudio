import { describe, expect, it } from 'bun:test';
import type { UpgradeReport, UpgradeStreamEvent } from '@mangostudio/shared/updates';
import type { ServerState } from '../../../../src/lib/server-state';
import {
  createUpgradeService,
  type UpgradeRunRequest,
  type UpgradeServiceDeps,
} from '../../../../src/modules/updates/application/upgrade-service';
import type {
  ResolvedArchiveDownload,
  ResolvedDownload,
} from '../../../../src/modules/updates/domain/resolve-target';
import type {
  RunScript,
  ScriptOutputLine,
  ScriptRun,
} from '../../../../src/modules/updates/infrastructure/run-script';
import {
  PROBE_VERSION as CURRENT_VERSION,
  dockerProbe,
  npmProbe,
  selfManagedProbe,
} from './support/install-origin-probes';

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

function newerTarget(overrides: Partial<ResolvedArchiveDownload> = {}): ResolvedDownload {
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
    stopHub: () => Promise.resolve(),
    restartHub: () => Promise.resolve(),
    currentExecutable: () => ({
      argv: ['/home/j/.mango/dist/current/mangostudio'],
      pointer: 'current',
    }),
    readState: () => Promise.resolve(detachedState()),
    isAlive: () => true,
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
      '--version',
      '0.1.2',
    ]);
    expect(script.calls[0]?.env.MANGOSTUDIO_INSTALL_ORIGIN).toBe('upgrade');
    expect(script.calls[0]?.env.MANGOSTUDIO_INSTALL_DIR).toBe('/home/j/.mango/dist');
    expect(script.calls[0]?.env.MANGOSTUDIO_BIN_DIR).toBe('/home/j/.local/bin');
    expect(script.calls[0]?.env.PATH).toBe('/usr/bin');

    expect(mkdirCalls).toEqual(['/home/j/.mango/dist/.staging-0.1.2-4242']);
    expect(removeDirCalls).toEqual(['/home/j/.mango/dist/.staging-0.1.2-4242']);
    expect(restartCalls).toEqual([{ state: detachedState(), launch: 'detached' }]);
  });

  it('passes the resolved sha-suffixed version for a canary archive, not the file name', async () => {
    // A canary archive's file name only carries "0.1.0-canary" (see
    // hubArchiveName); the manifest-resolved target.version carries the full
    // "0.1.0-canary.<sha7>" the binary reports. install.sh derives its own
    // version from the file name when --version is absent, so omitting it
    // here would make the post-install smoke check compare the truncated
    // name against the binary's real --version and fail every canary upgrade.
    const canaryVersion = '0.1.0-canary.abc1234';
    const script = fakeRunScript(0);
    const service = createUpgradeService(
      baseDeps({
        runScript: script.runScript,
        resolveUpgradeTarget: () =>
          Promise.resolve(
            newerTarget({
              version: canaryVersion,
              channel: 'canary',
              assetName: 'mangostudio-0.1.0-canary-linux-x64.tar.gz',
            })
          ),
      })
    );

    await collect(service);

    expect(script.calls[0]?.argv).toEqual([
      'bash',
      `/home/j/.mango/dist/.staging-${canaryVersion}-4242/install.sh`,
      '--local',
      '/staging/mangostudio-0.1.0-canary-linux-x64.tar.gz',
      '--version',
      canaryVersion,
    ]);
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

  it('reports not-running, and never restarts, when the state file survives a SIGKILL of a recycled pid', async () => {
    // A crash that skips cleanup leaves the old state file behind; its pid can
    // already belong to an unrelated process the OS recycled. Only isStateLive
    // tells the two apart — treating the file as live would SIGTERM that
    // unrelated pid and then report a restart that never happened.
    let restarted = false;
    const service = createUpgradeService(
      baseDeps({
        readState: () => Promise.resolve(detachedState()),
        isAlive: () => false,
        restartHub: () => {
          restarted = true;
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('not-running');
    expect(restarted).toBe(false);
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

  it('reports failed instead of mkdir-ing outside distRoot when a resolved version is a path traversal', async () => {
    // Schema validation (UPGRADE_VERSION_PATTERN) and parseUpgradeArgs reject
    // a version shaped like this before it reaches the engine in production,
    // but the engine is the last line of defense against a value that
    // reaches it some other way (a tampered install-origin.json, an
    // unvalidated upstream manifest) — it must never mkdir/rm -rf outside the
    // install root just because a version string contains "..".
    let mkdirCalled = false;
    const service = createUpgradeService(
      baseDeps({
        resolveUpgradeTarget: () =>
          Promise.resolve(newerTarget({ version: '../../../../../evil' })),
        mkdir: () => {
          mkdirCalled = true;
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(report.exitCode).toBe(2);
    expect(report.message).toContain('outside the install root');
    expect(mkdirCalled).toBe(false);
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
    expect(stages(events)).toEqual(['resolve', 'install', 'restart']);
  });

  it('restarts a live detached hub after the POSIX package manager succeeds', async () => {
    // npm/brew replace the file on disk, but a hub already running keeps
    // serving the old inode until something bounces it — the same restart
    // stage the self-managed path goes through.
    const restarts: { state: ServerState; launch: string }[] = [];
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe(),
        readState: () => Promise.resolve(detachedState({ pid: 999 })),
        isAlive: () => true,
        restartHub: (input) => {
          restarts.push(input);
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('scheduled');
    expect(restarts).toEqual([{ state: detachedState({ pid: 999 }), launch: 'detached' }]);
  });

  it('leaves a live hub alone after a POSIX delegation when asked --no-restart', async () => {
    let restarted = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe(),
        readState: () => Promise.resolve(detachedState({ pid: 999 })),
        isAlive: () => true,
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

  it('does not restart anything after a POSIX delegation when the package manager fails', async () => {
    let restarted = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe(),
        runScript: fakeRunScript(1).runScript,
        readState: () => Promise.resolve(detachedState({ pid: 999 })),
        isAlive: () => true,
        restartHub: () => {
          restarted = true;
          return Promise.resolve();
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(restarted).toBe(false);
  });

  it('never hands the hub secrets to the POSIX delegate, but keeps PATH and npm/cargo config', async () => {
    const script = fakeRunScript(0);
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe(),
        runScript: script.runScript,
        env: {
          PATH: '/usr/bin',
          BETTER_AUTH_SECRET: 'top-secret',
          ANTHROPIC_API_KEY: 'sk-also-secret',
          npm_config_registry: 'https://registry.example.test',
          CARGO_HOME: '/home/j/.cargo',
        },
      })
    );

    await collect(service);

    const env = script.calls[0]?.env;
    expect(env?.PATH).toBe('/usr/bin');
    expect(env?.npm_config_registry).toBe('https://registry.example.test');
    expect(env?.CARGO_HOME).toBe('/home/j/.cargo');
    expect(env?.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
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
    const waiterCalls: {
      argv: readonly string[];
      waitForPid: number | readonly number[];
      logFile: string;
      afterSuccess?: readonly string[];
    }[] = [];
    let ran = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        // No live hub owns the state file, so there is only this process's
        // pid to wait on.
        readState: () => Promise.resolve(null),
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
    expect(waiterCalls[0]?.afterSuccess).toBeUndefined();
    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('not-running');
    expect(report.logFile).toBe(waiterCalls[0]?.logFile);
    expect(report.message).toContain('runs after this process exits');
    expect(report.exitCode).toBe(0);
  });

  it('never hands the hub secrets to the Windows waiter either, but keeps the system block and npm config', async () => {
    // The waiter is the Windows twin of runPosixDelegate: powershell.exe
    // execs the package manager, and an npm postinstall inherits whatever
    // env the waiter was spawned with.
    const waiterCalls: { env: Record<string, string> }[] = [];
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        readState: () => Promise.resolve(null),
        env: {
          PATH: 'C:\\Windows\\System32',
          SystemRoot: 'C:\\Windows',
          BETTER_AUTH_SECRET: 'top-secret',
          ANTHROPIC_API_KEY: 'sk-also-secret',
          npm_config_registry: 'https://registry.example.test',
        },
        spawnDetachedWaiter: (input) => {
          waiterCalls.push(input);
          return 1;
        },
      })
    );

    await collect(service);

    const env = waiterCalls[0]?.env;
    expect(env?.PATH).toBe('C:\\Windows\\System32');
    expect(env?.SystemRoot).toBe('C:\\Windows');
    expect(env?.npm_config_registry).toBe('https://registry.example.test');
    expect(env?.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('stops a live detached hub first, then has the waiter bring it back once the manager succeeds', async () => {
    // The CLI invoking `mangostudio upgrade` (d.pid) is not the process
    // holding mangostudio.exe open — a hub launched separately (`serve -d`)
    // is, and nothing else in this flow would ever make it exit. The engine
    // stops it before spawning the waiter; the waiter's wait on both pids is
    // then a safety net, and its `afterSuccess` step is what restarts the hub.
    const stops: { state: ServerState; launch: string }[] = [];
    const waiterCalls: {
      waitForPid: number | readonly number[];
      afterSuccess?: readonly string[];
    }[] = [];
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        readState: () => Promise.resolve(detachedState({ pid: 999, host: '0.0.0.0', port: 4000 })),
        isAlive: () => true,
        stopHub: (input) => {
          stops.push(input);
          return Promise.resolve();
        },
        spawnDetachedWaiter: (input) => {
          waiterCalls.push(input);
          return 1;
        },
      })
    );

    const { report } = await collect(service);

    expect(stops).toEqual([
      { state: detachedState({ pid: 999, host: '0.0.0.0', port: 4000 }), launch: 'detached' },
    ]);
    expect(waiterCalls[0]?.waitForPid).toEqual([999, 555]);
    expect(waiterCalls[0]?.afterSuccess).toEqual(['mangostudio', 'serve', '-d', '0.0.0.0:4000']);
    expect(report.outcome).toBe('upgraded');
    expect(report.restart).toBe('scheduled');
    expect(report.message).toContain('PID 999');
  });

  it('brings a Scheduled Task hub back through "mangostudio restart", which starts the installed unit', async () => {
    const stops: { launch: string }[] = [];
    const waiterCalls: { afterSuccess?: readonly string[] }[] = [];
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        readState: () =>
          Promise.resolve(detachedState({ pid: 999, logFile: '', service: 'MangoStudio' })),
        isAlive: () => true,
        stopHub: (input) => {
          stops.push(input);
          return Promise.resolve();
        },
        spawnDetachedWaiter: (input) => {
          waiterCalls.push(input);
          return 1;
        },
      })
    );

    const { report } = await collect(service);

    expect(stops).toEqual([{ launch: 'service' }].map((s) => expect.objectContaining(s)));
    expect(waiterCalls[0]?.afterSuccess).toEqual(['mangostudio', 'restart']);
    expect(report.restart).toBe('scheduled');
  });

  it('still stops a live hub under --no-restart (the manager cannot replace a held file) and reports the restart as manual', async () => {
    let stopped = false;
    const waiterCalls: { afterSuccess?: readonly string[] }[] = [];
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        readState: () => Promise.resolve(detachedState({ pid: 999 })),
        isAlive: () => true,
        stopHub: () => {
          stopped = true;
          return Promise.resolve();
        },
        spawnDetachedWaiter: (input) => {
          waiterCalls.push(input);
          return 1;
        },
      })
    );

    const { report } = await collect(service, { restart: false });

    expect(stopped).toBe(true);
    expect(waiterCalls[0]?.afterSuccess).toBeUndefined();
    expect(report.restart).toBe('manual');
    expect(report.message).toContain('mangostudio serve -d localhost:3001');
  });

  it('fails without stopping or spawning anything when the live hub runs in the foreground', async () => {
    // The terminal that owns a foreground hub is the only thing that should
    // stop it — the same refusal `mangostudio restart` makes.
    let stopped = false;
    let spawned = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        readState: () => Promise.resolve(detachedState({ pid: 999, logFile: '' })),
        isAlive: () => true,
        stopHub: () => {
          stopped = true;
          return Promise.resolve();
        },
        spawnDetachedWaiter: () => {
          spawned = true;
          return 1;
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(report.exitCode).toBe(2);
    expect(report.message).toContain('PID 999');
    expect(report.message).toContain('Ctrl-C');
    expect(stopped).toBe(false);
    expect(spawned).toBe(false);
  });

  it('fails and spawns no waiter when the live hub does not stop', async () => {
    let spawned = false;
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        readState: () => Promise.resolve(detachedState({ pid: 999 })),
        isAlive: () => true,
        stopHub: () => Promise.reject(new Error('MangoStudio (PID 999) did not stop within 10s.')),
        spawnDetachedWaiter: () => {
          spawned = true;
          return 1;
        },
      })
    );

    const { report } = await collect(service);

    expect(report.outcome).toBe('failed');
    expect(report.message).toContain('did not stop within 10s');
    expect(spawned).toBe(false);
  });

  it('waits on only the CLI pid, and stops nothing, when the state file is stale (no live hub)', async () => {
    let stopped = false;
    const waiterCalls: { waitForPid: number | readonly number[] }[] = [];
    const service = createUpgradeService(
      baseDeps({
        probe: () => npmProbe({ platform: 'win32' }),
        platform: 'win32',
        pid: 555,
        readState: () => Promise.resolve(detachedState({ pid: 999 })),
        isAlive: () => false,
        stopHub: () => {
          stopped = true;
          return Promise.resolve();
        },
        spawnDetachedWaiter: (input) => {
          waiterCalls.push(input);
          return 1;
        },
      })
    );

    const { report } = await collect(service);

    expect(waiterCalls[0]?.waitForPid).toBe(555);
    expect(stopped).toBe(false);
    expect(report.restart).toBe('not-running');
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

describe('exit codes', () => {
  // Every outcome now maps to its exit code through one table in the engine
  // (OUTCOME_EXIT_CODES); this pins the contract the CLI and the SSE `done`
  // event both publish, so a new outcome cannot quietly inherit the wrong one.
  it('is 0 for upgraded, already-current and available, 1 for refused, 2 for failed', async () => {
    const upgraded = await createUpgradeService(baseDeps()).run(REQUEST, () => undefined);
    expect(upgraded).toMatchObject({ outcome: 'upgraded', exitCode: 0 });

    const alreadyCurrent = await createUpgradeService(
      baseDeps({
        resolveUpgradeTarget: () => Promise.resolve(newerTarget({ version: CURRENT_VERSION })),
      })
    ).run(REQUEST, () => undefined);
    expect(alreadyCurrent).toMatchObject({ outcome: 'already-current', exitCode: 0 });

    const available = await createUpgradeService(baseDeps()).run(
      { ...REQUEST, checkOnly: true },
      () => undefined
    );
    expect(available).toMatchObject({ outcome: 'available', exitCode: 0 });

    const refused = await createUpgradeService(baseDeps({ probe: () => dockerProbe() })).run(
      REQUEST,
      () => undefined
    );
    expect(refused).toMatchObject({ outcome: 'refused', exitCode: 1 });

    // The script's own non-zero code is named in the message; the wire code is 2.
    const failed = await createUpgradeService(
      baseDeps({ runScript: fakeRunScript(7).runScript })
    ).run(REQUEST, () => undefined);
    expect(failed).toMatchObject({ outcome: 'failed', exitCode: 2 });
    expect(failed.message).toContain('7');
  });
});
