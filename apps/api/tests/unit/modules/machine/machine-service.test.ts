import { describe, expect, it } from 'bun:test';
import { RuntimeServiceManagementError } from '@mangostudio/runtime';
import {
  MACHINE_CHECK_DETAIL_MAX,
  MACHINE_CHECK_LABEL_MAX,
  MACHINE_DOCTOR_CHECK_LIMIT,
  MACHINE_ERROR_MAX,
  MachineConfigWriteResponseSchema,
  MachineDoctorReportSchema,
  MachineStatusSchema,
} from '@mangostudio/shared/machine';
import { USER_SERVICE_ERROR_MAX } from '@mangostudio/shared/runtime-home';
import { MachineUpdateStatusSchema, type UpdateCheck } from '@mangostudio/shared/updates';
import Value from 'typebox/value';
import { tailLines } from '../../../../src/cli/log-tail';
import type { ServerState } from '../../../../src/lib/server-state';
import { parseTomlDocument } from '../../../../src/lib/toml';
import {
  createMachineService,
  MachineActionBlockedError,
  MachineActionUnavailableError,
  type MachineServiceDeps,
} from '../../../../src/modules/machine/application/machine-service';
import type { InstallOriginProbe } from '../../../../src/modules/updates/domain/install-origin';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';
import {
  FakeServiceManager,
  installedAndRunning,
} from '../../../support/mocks/fake-service-manager';

/**
 * Stands in for `config.toml` on disk: `read`/`write` are the two injected
 * deps `writeConfig` calls, and `write` round-trips through the real TOML
 * stringifier/parser so a test asserts against the same document a real file
 * would hold, without ever touching the filesystem.
 */
class FakeConfigFile {
  writes: Array<{ path: string; contents: string }> = [];

  constructor(
    private doc: Record<string, unknown> = {},
    private effectiveInstallsEnabled = true
  ) {}

  read = (_path: string): Record<string, unknown> => this.doc;

  write = (path: string, contents: string): void => {
    this.writes.push({ path, contents });
    this.doc = parseTomlDocument(contents);
  };

  reloadEffective = (): boolean => this.effectiveInstallsEnabled;

  setEffective(value: boolean): void {
    this.effectiveInstallsEnabled = value;
  }
}

const DETACHED: ServerState = {
  pid: 42,
  port: 3001,
  host: '127.0.0.1',
  startedAt: 1_000,
  logFile: '/home/j/.mango/logs/server-1.log',
  version: '0.1.1',
};
const SERVICE: ServerState = { ...DETACHED, service: 'mangostudio.service' };
const LOCAL = { clientIp: '127.0.0.1' };

class Recorder {
  readonly scheduled: Array<() => Promise<void> | void> = [];
  readonly spawned: ServerState[] = [];
  shutdowns = 0;

  async flush(): Promise<void> {
    for (const work of this.scheduled.splice(0)) await work();
  }
}

function makeService(
  overrides: Partial<MachineServiceDeps> = {},
  state: ServerState | null = DETACHED
) {
  const manager = new FakeServiceManager();
  const recorder = new Recorder();
  const deps: Partial<MachineServiceDeps> = {
    manager,
    controller: new FakeProcessController(state ? [state.pid] : []),
    readState: () => Promise.resolve(state),
    probeHealth: () => Promise.resolve(true),
    probeRuntimeBinary: () =>
      Promise.resolve({
        path: '/opt/mangostudio-runtime',
        present: true,
        version: '0.1.1',
        error: null,
      }),
    probeRuntimeSlots: () => Promise.resolve([]),
    collectDoctor: () =>
      Promise.resolve([
        { label: 'Config', status: 'ok', detail: 'fine' },
        { label: 'Database', status: 'warn', detail: 'slow' },
        { label: 'Frontend', status: 'fail', detail: 'gone' },
      ]),
    readLogTail: (_path, count) => Promise.resolve({ ...tailLines('a\nb\nc\n', count), offset: 6 }),
    latestLogFile: () => Promise.resolve('/home/j/.mango/logs/service.log'),
    evaluateGuard: (clientIp) =>
      clientIp === '127.0.0.1'
        ? { allowed: true, reasons: [] }
        : { allowed: false, reasons: ['client-not-loopback'] },
    environment: () => ({
      platform: 'linux',
      standalone: true,
      container: false,
      serverHost: '127.0.0.1',
      serverPort: 3001,
      homeDir: '/home/j/.mango',
      logsDir: '/home/j/.mango/logs',
      configFile: '/home/j/.mango/config.toml',
      version: '0.1.1',
      hostSlotDir: '/home/j/.mango/runtime/host',
      pid: 42,
    }),
    executable: () => ({ argv: ['/home/j/.mango/dist/current/mangostudio'], pointer: 'current' }),
    serviceLogFile: () => '/home/j/.mango/logs/service.log',
    secretPersisted: () => true,
    spawnSuccessor: (next) => {
      recorder.spawned.push(next);
    },
    shutdown: () => {
      recorder.shutdowns += 1;
    },
    schedule: (work) => {
      recorder.scheduled.push(work);
    },
    now: () => 6_000,
    env: { PATH: '/usr/bin' },
    ...overrides,
  };
  return { service: createMachineService(deps), manager, recorder };
}

describe('machineService.status', () => {
  it('assembles the shared status document for the serving process', async () => {
    const { service } = makeService();
    const status = await service.status(LOCAL);
    expect(Value.Check(MachineStatusSchema, status)).toBe(true);
    expect(status.hub).toMatchObject({ running: true, pid: 42, launch: 'detached', health: 'ok' });
    expect(status.runtimeBinary.versionMatches).toBe(true);
    expect(status.hostSlot).toEqual({
      present: false,
      profile: 'full',
      directory: '/home/j/.mango/runtime/host',
      error: null,
    });
    expect(status.actions.restart).toEqual({ available: true, command: 'mangostudio restart' });
  });

  it('reports the guard for a remote browser without hiding the rest', async () => {
    const { service } = makeService();
    const status = await service.status({ clientIp: '10.0.0.7' });
    expect(status.actions.guard.reasons).toEqual(['client-not-loopback']);
    expect(status.actions.restart.reason).toBe('guard');
    expect(status.hub.running).toBe(true);
  });

  it('says a LAN-bound hub is unprobed rather than unreachable', async () => {
    // The loopback probe refuses a host that is neither loopback nor bind-all,
    // so `false` there is "could not ask", not "did not answer".
    const { service } = makeService(
      { probeHealth: () => Promise.resolve(false), canProbeHealth: () => false },
      { ...DETACHED, pid: 99, host: '192.168.1.20' }
    );

    expect((await service.status(LOCAL)).hub.health).toBe('unprobed');
  });

  it('reports a version mismatch against the sibling runtime', async () => {
    const { service } = makeService({
      probeRuntimeBinary: () =>
        Promise.resolve({ path: '/x', present: true, version: '0.0.9', error: null }),
    });
    expect((await service.status(LOCAL)).runtimeBinary.versionMatches).toBe(false);
  });
});

describe('machineService.doctor and logs', () => {
  it('counts warnings and failures', async () => {
    const { service } = makeService();
    const report = await service.doctor([]);
    expect(report).toMatchObject({ warnings: 1, failures: 1 });
    expect(report.checks).toHaveLength(3);
  });

  it('tails the recorded log, falling back to the newest file', async () => {
    const { service } = makeService();
    expect(await service.logs(2, LOCAL)).toEqual({
      file: '/home/j/.mango/logs/server-1.log',
      lines: ['b', 'c'],
      truncated: true,
    });
    const fallback = makeService({}, { ...DETACHED, logFile: '' });
    expect((await fallback.service.logs(10, LOCAL)).file).toBe('/home/j/.mango/logs/service.log');
    const none = makeService({ latestLogFile: () => Promise.resolve(null) }, null);
    expect(await none.service.logs(10, LOCAL)).toEqual({ file: null, lines: [], truncated: false });
  });
});

// Nothing that fills these fields has a length of its own: a supervisor's
// stderr, a probe's error, a doctor detail, the number of MCP rows an account
// owns. A response that overruns its own schema is answered as a 500, so the
// page would lose the whole document over one long line.
describe('machineService fits its own wire contract', () => {
  it('cuts a doctor detail, a label and the row count to what the report schema holds', async () => {
    const { service } = makeService({
      collectDoctor: () =>
        Promise.resolve(
          Array.from({ length: MACHINE_DOCTOR_CHECK_LIMIT + 5 }, () => ({
            label: 'L'.repeat(MACHINE_CHECK_LABEL_MAX + 10),
            status: 'warn' as const,
            detail: 'D'.repeat(MACHINE_CHECK_DETAIL_MAX + 10),
          }))
        ),
    });
    const report = await service.doctor([]);
    expect(Value.Check(MachineDoctorReportSchema, report)).toBe(true);
    expect(report.checks).toHaveLength(MACHINE_DOCTOR_CHECK_LIMIT);
    expect(report.checks[0]?.detail).toHaveLength(MACHINE_CHECK_DETAIL_MAX);
    expect(report.checks[0]?.label).toHaveLength(MACHINE_CHECK_LABEL_MAX);
  });

  it('cuts a supervisor error and a probe error to what the status schema holds', async () => {
    const manager = new FakeServiceManager();
    manager.setStatus({ error: 'E'.repeat(USER_SERVICE_ERROR_MAX + 10) });
    const { service } = makeService({
      manager,
      probeRuntimeBinary: () =>
        Promise.resolve({
          path: '/opt/mangostudio-runtime',
          present: true,
          version: null,
          error: 'X'.repeat(MACHINE_ERROR_MAX + 10),
        }),
    });
    const status = await service.status(LOCAL);
    expect(Value.Check(MachineStatusSchema, status)).toBe(true);
    expect(status.service.error).toHaveLength(USER_SERVICE_ERROR_MAX);
    expect(status.runtimeBinary.error).toHaveLength(MACHINE_ERROR_MAX);
  });
});

describe('machineService.logs guard', () => {
  it('refuses the raw log to a browser that is not on this machine', async () => {
    const { service } = makeService();
    await expect(service.logs(10, { clientIp: '10.0.0.7' })).rejects.toBeInstanceOf(
      MachineActionBlockedError
    );
  });
});

describe('machineService.restart', () => {
  it('spawns a successor and shuts down after the response for a detached hub', async () => {
    const { service, recorder } = makeService();
    const response = await service.restart(LOCAL);
    expect(response.accepted).toBe(true);
    expect(recorder.spawned).toEqual([]);
    await recorder.flush();
    expect(recorder.spawned).toEqual([DETACHED]);
    expect(recorder.shutdowns).toBe(1);
  });

  it('asks the supervisor for a service-managed hub', async () => {
    const { service, manager, recorder } = makeService({}, SERVICE);
    manager.setStatus(installedAndRunning());
    const response = await service.restart(LOCAL);
    expect(response).toMatchObject({ outcome: 'restarting-service', unit: 'mangostudio.service' });
    await recorder.flush();
    expect(manager.calls).toContain('restart');
    expect(recorder.shutdowns).toBe(0);
  });

  it('refuses a remote browser with the guard, and a foreground hub with the command', async () => {
    const { service } = makeService();
    await expect(service.restart({ clientIp: '10.0.0.7' })).rejects.toBeInstanceOf(
      MachineActionBlockedError
    );
    const foreground = makeService({}, { ...DETACHED, logFile: '' });
    await expect(foreground.service.restart(LOCAL)).rejects.toMatchObject({
      name: 'MachineActionUnavailableError',
      reason: 'foreground',
      command: 'mangostudio restart',
    });
  });
});

describe('machineService.service', () => {
  it('installs the unit and hands over to it after responding', async () => {
    const { service, manager, recorder } = makeService();
    const response = await service.service('install', LOCAL);
    expect(response.accepted).toBe(true);
    expect(manager.calls).toEqual(['status', 'install']);
    expect(manager.installed[0]?.argv).toEqual([
      '/home/j/.mango/dist/current/mangostudio',
      'serve',
    ]);
    expect(manager.installed[0]?.env).not.toHaveProperty('API_PORT');
    expect(recorder.shutdowns).toBe(0);
    await recorder.flush();
    expect(recorder.shutdowns).toBe(1);
  });

  it('bakes the running bind target into the unit when it differs from config', async () => {
    const { service, manager } = makeService({}, { ...DETACHED, host: '0.0.0.0', port: 4000 });
    await service.service('install', LOCAL);
    expect(manager.installed[0]?.env).toMatchObject({ API_HOST: '0.0.0.0', API_PORT: '4000' });
  });

  it('refuses to install twice, and refuses without a persisted secret', async () => {
    const { service, manager } = makeService();
    manager.setStatus(installedAndRunning());
    await expect(service.service('install', LOCAL)).rejects.toMatchObject({
      reason: 'already-installed',
    });
    const unsaved = makeService({ secretPersisted: () => false });
    await expect(unsaved.service.service('install', LOCAL)).rejects.toBeInstanceOf(
      MachineActionUnavailableError
    );
  });

  it('turns a supervisor install refusal into a 409-shaped reason, not a raw throw', async () => {
    const { service, manager } = makeService();
    manager.installFailWith = new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      'The Scheduled Task command for mangostudio.service is 9000 characters, over the 8192 Task Scheduler accepts.'
    );
    await expect(service.service('install', LOCAL)).rejects.toMatchObject({
      name: 'MachineActionUnavailableError',
      reason: 'install-failed',
      command: 'mangostudio service install',
    });
  });

  // The sibling of the install case above: the supervisor refuses each verb on
  // its own, and a raw RuntimeServiceManagementError past `mapMachineError` is
  // a 500 with the supervisor's English in it.
  it('turns a supervisor uninstall refusal into a 409-shaped reason, not a raw throw', async () => {
    const { service, manager } = makeService();
    manager.setStatus(installedAndRunning());
    manager.uninstallFailWith = new RuntimeServiceManagementError(
      'runtime_service_no_session_bus',
      'No D-Bus session bus for systemd user services.'
    );
    await expect(service.service('uninstall', LOCAL)).rejects.toMatchObject({
      name: 'MachineActionUnavailableError',
      reason: 'uninstall-failed',
      command: 'mangostudio service uninstall',
    });
  });

  it('removes the unit now for a detached hub, after responding for a service-managed one', async () => {
    const { service, manager, recorder } = makeService();
    manager.setStatus({ ...installedAndRunning(), running: false });
    const response = await service.service('uninstall', LOCAL);
    expect(response.outcome).toBe('service-removed');
    expect(manager.calls).toContain('uninstall');
    expect(recorder.scheduled).toHaveLength(0);

    const managed = makeService({}, SERVICE);
    managed.manager.setStatus(installedAndRunning());
    const deferred = await managed.service.service('uninstall', LOCAL);
    expect(deferred.outcome).toBe('service-removing');
    expect(managed.manager.calls).not.toContain('uninstall');
    await managed.recorder.flush();
    expect(managed.manager.calls).toContain('uninstall');
  });
});

describe('machineService.writeConfig', () => {
  const BODY = { environments: { installsEnabled: true as const } };

  function makeConfigService(fake: FakeConfigFile, overrides: Partial<MachineServiceDeps> = {}) {
    return createMachineService({
      configFilePath: () => '/home/j/.mango/config.toml',
      readConfigDocument: fake.read,
      writeConfigFile: fake.write,
      reloadEffectiveInstallsEnabled: fake.reloadEffective,
      evaluateGuard: (clientIp) =>
        clientIp === '127.0.0.1'
          ? { allowed: true, reasons: [] }
          : { allowed: false, reasons: ['client-not-loopback'] },
      ...overrides,
    });
  }

  it('reads and writes through a symlinked config.toml, reporting the target', async () => {
    const fake = new FakeConfigFile({});
    const service = makeConfigService(fake, {
      resolveConfigPath: (path) =>
        path === '/home/j/.mango/config.toml' ? '/home/j/dotfiles/mango.toml' : path,
    });

    const response = await service.writeConfig(BODY, LOCAL);

    expect(response.configFile).toBe('/home/j/dotfiles/mango.toml');
    expect(fake.writes.map((write) => write.path)).toEqual(['/home/j/dotfiles/mango.toml']);
  });

  it('creates the [environments] table when the file has none', async () => {
    const fake = new FakeConfigFile({});
    const service = makeConfigService(fake);
    const response = await service.writeConfig(BODY, LOCAL);
    expect(Value.Check(MachineConfigWriteResponseSchema, response)).toBe(true);
    expect(response).toEqual({
      applied: true,
      configFile: '/home/j/.mango/config.toml',
      installsEnabled: true,
    });
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]?.path).toBe('/home/j/.mango/config.toml');
    expect(parseTomlDocument(fake.writes[0]?.contents ?? '')).toEqual({
      environments: { installs_enabled: true },
    });
  });

  it('preserves every other key already in the file', async () => {
    const fake = new FakeConfigFile({
      server: { port: 4000 },
      environments: { lts_refresh: true },
    });
    const service = makeConfigService(fake);
    await service.writeConfig(BODY, LOCAL);
    expect(parseTomlDocument(fake.writes[0]?.contents ?? '')).toEqual({
      server: { port: 4000 },
      environments: { lts_refresh: true, installs_enabled: true },
    });
  });

  it('reports applied: false with reason env-override when .env still overrides it', async () => {
    const fake = new FakeConfigFile({});
    fake.setEffective(false);
    const service = makeConfigService(fake);
    const response = await service.writeConfig(BODY, LOCAL);
    expect(response).toEqual({
      applied: false,
      configFile: '/home/j/.mango/config.toml',
      installsEnabled: false,
      reason: 'env-override',
    });
    // The write still happened: the file is meant to say `true` from now on
    // even though the environment override holds the effective value at false.
    expect(fake.writes).toHaveLength(1);
  });

  it('refuses a remote browser with the guard, before touching the file', async () => {
    const fake = new FakeConfigFile({});
    const service = makeConfigService(fake);
    await expect(service.writeConfig(BODY, { clientIp: '10.0.0.7' })).rejects.toBeInstanceOf(
      MachineActionBlockedError
    );
    expect(fake.writes).toHaveLength(0);
  });
});

/** Stands in for the release checker: no network, an answer scripted per test. */
class FakeUpdateChecker {
  checkCalls = 0;

  constructor(private readonly cached: UpdateCheck | null) {}

  readCached = (): UpdateCheck | null => this.cached;

  check = (): Promise<UpdateCheck | null> => {
    this.checkCalls += 1;
    return Promise.resolve(this.cached);
  };
}

function installOriginProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: '/home/j/.mango/dist/current/mangostudio',
    version: '0.1.1',
    standalone: true,
    container: false,
    home: '/home/j',
    readFile: () => null,
    ...overrides,
  };
}

describe('machineService.update', () => {
  it('reports a delegate plan and does not offer to upgrade for a bun-launched hub', async () => {
    const checker = new FakeUpdateChecker({
      channel: 'stable',
      currentVersion: '0.1.1',
      latestVersion: '0.1.1',
      updateAvailable: false,
      checkedAt: 6_000,
    });
    const { service } = makeService({
      installOriginProbe: () =>
        installOriginProbe({
          execPath: '/home/j/.bun/install/global/node_modules/mangostudio/bin/mangostudio',
        }),
      updatesConfig: () => ({ check: true, channel: null }),
      checker,
    });

    const status = await service.update();

    expect(Value.Check(MachineUpdateStatusSchema, status)).toBe(true);
    expect(status.installedVia.manager).toBe('bun');
    expect(status.canUpgrade).toBe(false);
    expect(status.reason).toBe('package-manager');
    expect(status.command).toBe('bun add -g mangostudio@latest');
    expect(checker.checkCalls).toBe(1);
  });

  it('reports an available update for a self-managed hub', async () => {
    const checker = new FakeUpdateChecker({
      channel: 'stable',
      currentVersion: '0.1.1',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checkedAt: 6_000,
    });
    const { service } = makeService({
      installOriginProbe: () => installOriginProbe(),
      updatesConfig: () => ({ check: true, channel: null }),
      checker,
    });

    const status = await service.update();

    expect(status.installedVia.manager).toBe('self-managed');
    expect(status.canUpgrade).toBe(true);
    expect(status.reason).toBeUndefined();
    expect(status.command).toBe('mangostudio upgrade');
    expect(status.check).toMatchObject({ latestVersion: '0.2.0', updateAvailable: true });
  });

  it('reports checks disabled without reading or refreshing the cache', async () => {
    const checker = new FakeUpdateChecker({
      channel: 'stable',
      currentVersion: '0.1.1',
      updateAvailable: false,
      checkedAt: 6_000,
    });
    const { service } = makeService({
      installOriginProbe: () => installOriginProbe(),
      updatesConfig: () => ({ check: false, channel: null }),
      checker,
    });

    const status = await service.update();

    expect(status.checksEnabled).toBe(false);
    expect(status.check).toBeNull();
    expect(checker.checkCalls).toBe(0);
  });
});
