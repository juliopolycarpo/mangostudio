import { describe, expect, it } from 'bun:test';
import { RuntimeServiceManagementError } from '@mangostudio/runtime';
import { runService, type ServiceDeps } from '../../../../src/cli/commands/service';
import { CliError } from '../../../../src/cli/errors';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';
import {
  FakeServiceManager,
  installedAndRunning,
} from '../../../support/mocks/fake-service-manager';

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: '127.0.0.1',
  startedAt: 0,
  logFile: '/home/test/.mango/logs/server-1.log',
  version: 't',
};

const noop = (): Promise<void> => Promise.resolve();

function baseDeps(overrides: Partial<Omit<ServiceDeps, 'manager'>> = {}): Partial<ServiceDeps> & {
  lines: string[];
  manager: FakeServiceManager;
} {
  const lines: string[] = [];
  const manager = new FakeServiceManager();
  let now = 0;
  return {
    lines,
    manager,
    controller: new FakeProcessController(),
    readState: () => Promise.resolve(null),
    removeState: noop,
    log: (msg) => lines.push(msg),
    ensureAuthSecret: () => Promise.resolve(),
    assertServeConfig: () => undefined,
    ensureDirs: noop,
    executable: () => ({
      argv: ['/home/test/.mango/dist/current/mangostudio'],
      pointer: 'current',
    }),
    logFile: () => '/home/test/.mango/logs/service.log',
    platform: 'linux',
    env: { PATH: '/usr/bin', BETTER_AUTH_SECRET: 'never-in-a-unit' },
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('runService install', () => {
  it('writes a unit that runs serve through the current pointer, without secrets', async () => {
    const d = baseDeps();
    await runService({ action: 'install', json: false }, d);

    expect(d.manager.calls).toEqual(['install']);
    const definition = d.manager.installed[0];
    expect(definition?.argv).toEqual(['/home/test/.mango/dist/current/mangostudio', 'serve']);
    expect(definition?.logFile).toBe('/home/test/.mango/logs/service.log');
    expect(definition?.env).toEqual({
      PATH: '/usr/bin',
      MANGO_LOG_FILE: '/home/test/.mango/logs/service.log',
      MANGOSTUDIO_SERVICE_UNIT: 'mangostudio.service',
    });
    expect(d.lines[0]).toBe('Installed and started the MangoStudio service (mangostudio.service).');
  });

  it('bakes an explicit target into the unit and validates the port', async () => {
    const d = baseDeps();
    await runService({ action: 'install', host: '0.0.0.0', port: 3000, json: false }, d);
    expect(d.manager.installed[0]?.env).toMatchObject({ API_HOST: '0.0.0.0', API_PORT: '3000' });

    await expect(
      runService({ action: 'install', port: 70_000, json: false }, baseDeps())
    ).rejects.toBeInstanceOf(CliError);
  });

  it('runs the auth-secret setup while there is still a terminal', async () => {
    const order: string[] = [];
    const d = baseDeps({
      ensureAuthSecret: () => {
        order.push('secret');
        return Promise.resolve();
      },
    });
    d.manager.install = (definition) => {
      order.push('install');
      d.manager.installed.push(definition);
      return Promise.resolve();
    };
    await runService({ action: 'install', json: false }, d);
    expect(order).toEqual(['secret', 'install']);
  });

  it('installs the unit before stopping an instance started by hand', async () => {
    const order: string[] = [];
    const controller = new FakeProcessController([42]);
    controller.terminate = (pid) => {
      order.push('terminate');
      controller.die(pid);
    };
    const d = baseDeps({
      controller,
      readState: () => Promise.resolve(STATE),
    });
    d.manager.install = (definition) => {
      order.push('install');
      d.manager.installed.push(definition);
      return Promise.resolve();
    };

    await runService({ action: 'install', json: false }, d);

    // The other way round leaves a user whose install fails with neither the
    // server they had nor the service they asked for.
    expect(order).toEqual(['install', 'terminate']);
    expect(d.lines[0]).toContain('Stopping the instance started outside the service (PID 42)');
  });

  it('leaves the running instance alone when the unit cannot be installed', async () => {
    const controller = new FakeProcessController([42]);
    const d = baseDeps({ controller, readState: () => Promise.resolve(STATE) });
    d.manager.install = () => Promise.reject(new Error('systemctl enable --now failed'));

    await expect(runService({ action: 'install', json: false }, d)).rejects.toThrow(
      /systemctl enable --now failed/
    );

    expect(controller.terminated).toEqual([]);
    expect(controller.isAlive(42)).toBe(true);
  });

  it('says the unit is installed when the instance it replaces will not stop', async () => {
    const d = baseDeps({
      controller: new FakeProcessController([42]),
      readState: () => Promise.resolve(STATE),
    });

    await expect(runService({ action: 'install', json: false }, d)).rejects.toThrow(
      /is installed, but the instance started outside it \(PID 42\) did not stop within 10s/
    );
    expect(d.manager.calls).toEqual(['install']);
  });

  it('restarts a service that is already running so it reads the rewritten unit', async () => {
    const d = baseDeps({
      controller: new FakeProcessController([42]),
      readState: () => Promise.resolve({ ...STATE, service: 'mangostudio.service' }),
    });
    await runService({ action: 'install', json: false }, d);
    expect(d.manager.calls).toEqual(['install', 'restart']);
  });

  it('prints the resolver note when the unit cannot point at a launcher', async () => {
    const d = baseDeps({
      executable: () => ({
        argv: ['/home/test/.mango/dist/0.1.1/mangostudio'],
        pointer: 'versioned',
        note: 'No launcher at /home/test/.mango/dist/current/mangostudio; reinstall after an upgrade.',
      }),
    });
    await runService({ action: 'install', json: false }, d);
    expect(d.lines.join('\n')).toContain('Note:    No launcher at');
  });

  it('turns a manager refusal into a CLI error', async () => {
    const d = baseDeps();
    d.manager.failWith = new RuntimeServiceManagementError(
      'runtime_service_no_session_bus',
      'No D-Bus session bus for systemd user services.'
    );
    await expect(runService({ action: 'install', json: false }, d)).rejects.toMatchObject({
      name: 'CliError',
      message: 'No D-Bus session bus for systemd user services.',
    });
  });
});

describe('runService other actions', () => {
  it('prints status as text and as JSON', async () => {
    const d = baseDeps();
    d.manager.setStatus(installedAndRunning());
    await runService({ action: 'status', json: false }, d);
    expect(d.lines).toEqual([
      'Service:   mangostudio.service (linux)',
      'Installed: true',
      'Enabled:   true',
      'Running:   true',
      'Linger:    true',
    ]);

    const json = baseDeps();
    json.manager.setStatus(installedAndRunning());
    await runService({ action: 'status', json: true }, json);
    expect(JSON.parse(json.lines.join('\n'))).toMatchObject({ installed: true, running: true });
  });

  it.each(['uninstall', 'start', 'stop', 'restart'] as const)(
    'routes %s to the manager and names the unit',
    async (action) => {
      const d = baseDeps({ platform: 'darwin' });
      await runService({ action, json: false }, d);
      expect(d.manager.calls).toEqual([action]);
      expect(d.lines[0]).toContain('com.mangostudio.hub');
    }
  );
});
