import { afterEach, describe, expect, it } from 'bun:test';
import {
  type MachineDoctorReport,
  MachineDoctorReportSchema,
  type MachineLogTail,
  MachineLogTailSchema,
  type MachineStatus,
  MachineStatusSchema,
} from '@mangostudio/shared/machine';
import Value from 'typebox/value';
import {
  MachineActionBlockedError,
  MachineActionUnavailableError,
  type MachineService,
} from '../../../src/modules/machine/application/machine-service';
import {
  createMachineRoutes,
  parseDoctorSections,
} from '../../../src/modules/machine/http/machine-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'machine-user',
  name: 'Machine User',
  email: 'machine@mangostudio.test',
};

const STATUS: MachineStatus = {
  hub: { running: true, pid: 42, port: 3001, host: '127.0.0.1', launch: 'detached' },
  service: {
    schemaVersion: 1,
    platform: 'linux',
    unitName: 'mangostudio.service',
    installed: false,
    enabled: false,
    running: false,
  },
  runtimeBinary: { path: null, present: false, version: null, versionMatches: null, error: null },
  hostSlot: {
    present: false,
    profile: 'full',
    directory: '/home/j/.mango/runtime/host',
    error: null,
  },
  platform: 'linux',
  standalone: false,
  container: false,
  homeDir: '/home/j/.mango',
  logsDir: '/home/j/.mango/logs',
  configFile: null,
  actions: {
    guard: { allowed: true, reasons: [] },
    restart: { available: true, command: 'mangostudio restart' },
    installService: { available: true, command: 'mangostudio service install' },
    uninstallService: {
      available: false,
      command: 'mangostudio service uninstall',
      reason: 'not-installed',
    },
  },
};

/** Records what the routes asked for and answers from fixtures. */
class FakeMachineService implements MachineService {
  readonly clientIps: Array<string | undefined> = [];
  readonly doctorSections: string[][] = [];
  readonly tails: number[] = [];
  readonly actions: string[] = [];
  refuseWith: Error | null = null;

  status(context: { clientIp: string | undefined }): Promise<MachineStatus> {
    this.clientIps.push(context.clientIp);
    return Promise.resolve(STATUS);
  }

  doctor(sections: readonly string[]): Promise<MachineDoctorReport> {
    this.doctorSections.push([...sections]);
    return Promise.resolve({
      checks: [{ label: 'Config', status: 'ok', detail: 'fine' }],
      warnings: 0,
      failures: 0,
    });
  }

  logs(tail: number): Promise<MachineLogTail> {
    this.tails.push(tail);
    if (this.refuseWith) return Promise.reject(this.refuseWith);
    return Promise.resolve({ file: '/x.log', lines: ['a'], truncated: false });
  }

  restart() {
    this.actions.push('restart');
    if (this.refuseWith) return Promise.reject(this.refuseWith);
    return Promise.resolve({ accepted: true, message: 'restarting' });
  }

  service(action: 'install' | 'uninstall') {
    this.actions.push(action);
    if (this.refuseWith) return Promise.reject(this.refuseWith);
    return Promise.resolve({ accepted: true, message: action });
  }
}

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function mount(service: FakeMachineService, trustProxy = false) {
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createMachineRoutes(service, () => trustProxy)
  );
  restoreAuth = restore;
  return app;
}

describe('machine routes', () => {
  it('serves the status document to a signed-in user', async () => {
    const service = new FakeMachineService();
    const response = await mount(service).handle(new Request('http://localhost/machine/status'));
    expect(response.status).toBe(200);
    expect(Value.Check(MachineStatusSchema, await response.json())).toBe(true);
    // `app.handle` has no socket, so the peer is unknown — which is exactly
    // what the guard must treat as not local.
    expect(service.clientIps).toEqual(['unknown']);
  });

  it('ignores a forged forwarded client when no proxy is trusted', async () => {
    const service = new FakeMachineService();
    await mount(service).handle(
      new Request('http://localhost/machine/status', {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })
    );

    expect(service.clientIps).toEqual(['unknown']);
  });

  it('resolves the client through a trusted proxy so a remote session is not local', async () => {
    const service = new FakeMachineService();
    await mount(service, true).handle(
      new Request('http://localhost/machine/status', {
        headers: { 'x-forwarded-for': '203.0.113.5' },
      })
    );

    // Behind nginx or Caddy the socket peer is the loopback proxy for every
    // caller. Taking it alone would let a remote browser read this machine's
    // raw log and restart the hub.
    expect(service.clientIps).toEqual(['203.0.113.5']);
  });

  it('refuses without a session', async () => {
    const app = createApiTestApp(createMachineRoutes(new FakeMachineService()));
    const response = await app.handle(new Request('http://localhost/machine/status'));
    expect(response.status).toBe(401);
  });

  it('parses doctor sections and rejects unknown ones', async () => {
    const service = new FakeMachineService();
    const app = mount(service);
    const ok = await app.handle(new Request('http://localhost/machine/doctor?sections=library'));
    expect(ok.status).toBe(200);
    expect(Value.Check(MachineDoctorReportSchema, await ok.json())).toBe(true);
    expect(service.doctorSections).toEqual([['library']]);

    const bad = await app.handle(new Request('http://localhost/machine/doctor?sections=chatgpt'));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('tails logs with a bounded count', async () => {
    const service = new FakeMachineService();
    const app = mount(service);
    const response = await app.handle(new Request('http://localhost/machine/logs?tail=50'));
    expect(response.status).toBe(200);
    expect(Value.Check(MachineLogTailSchema, await response.json())).toBe(true);
    expect(service.tails).toEqual([50]);

    const tooMany = await app.handle(new Request('http://localhost/machine/logs?tail=999999'));
    expect(tooMany.status).toBe(422);

    service.refuseWith = new MachineActionBlockedError({
      allowed: false,
      reasons: ['client-not-loopback'],
    });
    const refused = await app.handle(new Request('http://localhost/machine/logs?tail=50'));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('accepts a restart and a service action', async () => {
    const service = new FakeMachineService();
    const app = mount(service);
    const restart = await app.handle(
      new Request('http://localhost/machine/restart', { method: 'POST' })
    );
    expect(restart.status).toBe(202);
    expect(await restart.json()).toEqual({ accepted: true, message: 'restarting' });

    const install = await app.handle(
      new Request('http://localhost/machine/service', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install' }),
      })
    );
    expect(install.status).toBe(202);
    expect(service.actions).toEqual(['restart', 'install']);

    const bogus = await app.handle(
      new Request('http://localhost/machine/service', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'enable' }),
      })
    );
    expect(bogus.status).toBe(422);
  });

  it('maps a guard refusal to 403 with the reasons, and an unavailable action to 409', async () => {
    const service = new FakeMachineService();
    const app = mount(service);
    service.refuseWith = new MachineActionBlockedError({
      allowed: false,
      reasons: ['client-not-loopback'],
    });
    const blocked = await app.handle(
      new Request('http://localhost/machine/restart', { method: 'POST' })
    );
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { reasons: 'client-not-loopback' },
    });

    service.refuseWith = new MachineActionUnavailableError('foreground', 'mangostudio restart');
    const unavailable = await app.handle(
      new Request('http://localhost/machine/restart', { method: 'POST' })
    );
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({
      code: 'UNSUPPORTED',
      details: { reason: 'foreground', command: 'mangostudio restart' },
    });
  });
});

describe('parseDoctorSections', () => {
  it('reads a comma list, ignores blanks, and refuses unknown names', () => {
    expect(parseDoctorSections(undefined)).toEqual([]);
    expect(parseDoctorSections(' environments, ,library ')).toEqual(['environments', 'library']);
    expect(parseDoctorSections('mcp')).toBeNull();
  });
});
