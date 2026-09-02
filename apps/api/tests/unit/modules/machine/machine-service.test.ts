import { describe, expect, it } from 'bun:test';
import { RuntimeServiceManagementError } from '@mangostudio/runtime';
import {
  MACHINE_CHECK_DETAIL_MAX,
  MACHINE_CHECK_LABEL_MAX,
  MACHINE_DOCTOR_CHECK_LIMIT,
  MACHINE_ERROR_MAX,
  MachineDoctorReportSchema,
  MachineStatusSchema,
} from '@mangostudio/shared/machine';
import { USER_SERVICE_ERROR_MAX } from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import { tailLines } from '../../../../src/cli/log-tail';
import type { ServerState } from '../../../../src/lib/server-state';
import {
  createMachineService,
  MachineActionBlockedError,
  MachineActionUnavailableError,
  type MachineServiceDeps,
} from '../../../../src/modules/machine/application/machine-service';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';
import {
  FakeServiceManager,
  installedAndRunning,
} from '../../../support/mocks/fake-service-manager';

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
