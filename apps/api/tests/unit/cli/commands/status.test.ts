import { describe, expect, it } from 'bun:test';
import { type HubProcessStatus, HubProcessStatusSchema } from '@mangostudio/shared/machine';
import type { UpdateCheck } from '@mangostudio/shared/updates';
import Value from 'typebox/value';
import { runStatus } from '../../../../src/cli/commands/status';
import type { ServerState } from '../../../../src/lib/server-state';
import type { InstallStatus } from '../../../../src/modules/updates/application/install-status';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: 'localhost',
  startedAt: 0,
  logFile: '/x.log',
  version: 't',
  buildInfo: {
    gitSha: 'abc123',
    gitDirty: false,
    builtAt: '2026-07-04T12:00:00.000Z',
    buildType: 'production',
  },
};

function capture(): { lines: string[]; log: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, log: (msg) => lines.push(msg) };
}

const noop = (): Promise<void> => Promise.resolve();
const TEXT = { json: false };
const JSON_ARGS = { json: true };
const healthy = (): Promise<boolean> => Promise.resolve(true);

const SELF_MANAGED_STATUS: InstallStatus = {
  installedVia: {
    manager: 'self-managed',
    channel: 'stable',
    executable: '/home/j/.mango/dist/current/mangostudio',
  },
  channel: 'stable',
  plan: { kind: 'self' },
  command: 'mangostudio upgrade',
};

/** Never touches the network or the developer's real ~/.mango. */
const RUNNING_DEPS = {
  installStatus: () => SELF_MANAGED_STATUS,
  readCachedUpdate: (): UpdateCheck | null => null,
};

describe('runStatus', () => {
  it('reports not running when there is no state', async () => {
    const { lines, log } = capture();

    await runStatus(TEXT, {
      readState: () => Promise.resolve(null),
      removeState: noop,
      controller: new FakeProcessController(),
      probeHealth: healthy,
      log,
      now: () => 0,
    });

    expect(lines).toEqual(['MangoStudio is not running.']);
  });

  it('cleans up a stale state file', async () => {
    const { lines, log } = capture();
    let removed = false;

    await runStatus(TEXT, {
      readState: () => Promise.resolve(STATE),
      removeState: () => {
        removed = true;
        return Promise.resolve();
      },
      controller: new FakeProcessController([]),
      probeHealth: healthy,
      log,
      now: () => 0,
    });

    expect(removed).toBe(true);
    expect(lines[0]).toBe('MangoStudio is not running.');
  });

  it('prints details for a healthy running instance', async () => {
    const { lines, log } = capture();

    await runStatus(TEXT, {
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: healthy,
      log,
      now: () => 5000,
      ...RUNNING_DEPS,
    });

    const text = lines.join('\n');
    expect(text).toContain('MangoStudio is running.');
    expect(text).toContain('PID:     42');
    expect(text).toContain('Uptime:  5s');
    expect(text).toContain('Health:  ok');
    expect(text).toContain('URL:     http://localhost:3001');
    expect(text).toContain('Launch:  detached');
    expect(text).toContain('Version: t (abc123)');
    expect(text).toContain('Build:   abc123');
  });

  it('reports an instance whose health endpoint does not answer', async () => {
    const { lines, log } = capture();

    await runStatus(TEXT, {
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: () => Promise.resolve(false),
      log,
      now: () => 5000,
      ...RUNNING_DEPS,
    });

    expect(lines.join('\n')).toContain('Health:  unreachable');
  });

  it('does not call a LAN-bound instance unreachable when it cannot be probed', async () => {
    const { lines, log } = capture();

    await runStatus(TEXT, {
      readState: () => Promise.resolve({ ...STATE, host: '192.168.1.20' }),
      removeState: noop,
      controller: new FakeProcessController([42]),
      // The real probe refuses a host that is neither loopback nor bind-all
      // rather than fetch an address named in a local state file, so a `false`
      // here says nothing about the server.
      probeHealth: () => Promise.resolve(false),
      log,
      now: () => 5000,
      ...RUNNING_DEPS,
    });

    expect(lines.join('\n')).toContain('Health:  unprobed');
  });

  it('prints the install origin, and an update line when one is cached', async () => {
    const { lines, log } = capture();

    await runStatus(TEXT, {
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: healthy,
      log,
      now: () => 5000,
      installStatus: () => SELF_MANAGED_STATUS,
      readCachedUpdate: () => ({
        channel: 'stable',
        currentVersion: 't',
        latestVersion: '0.2.0',
        updateAvailable: true,
        checkedAt: 0,
      }),
    });

    const text = lines.join('\n');
    expect(text).toContain('Installed via: install script · channel: stable');
    expect(text).toContain('Update:  0.2.0 available — run: mangostudio upgrade');
  });

  it('prints the install origin and nothing else when no update is cached', async () => {
    const { lines, log } = capture();

    await runStatus(TEXT, {
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: healthy,
      log,
      now: () => 5000,
      ...RUNNING_DEPS,
    });

    const text = lines.join('\n');
    expect(text).toContain('Installed via: install script · channel: stable');
    expect(text).not.toContain('Update:');
  });

  it('prints the shared status document with --json', async () => {
    const { lines, log } = capture();

    await runStatus(JSON_ARGS, {
      readState: () => Promise.resolve({ ...STATE, service: 'mangostudio.service' }),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: healthy,
      log,
      now: () => 5000,
    });

    const document = JSON.parse(lines.join('\n')) as HubProcessStatus;
    expect(Value.Check(HubProcessStatusSchema, document)).toBe(true);
    expect(document).toMatchObject({
      running: true,
      pid: 42,
      port: 3001,
      host: 'localhost',
      url: 'http://localhost:3001',
      uptimeMs: 5000,
      health: 'ok',
      launch: 'service',
      serviceUnit: 'mangostudio.service',
      buildSha: 'abc123',
    });
  });

  it('prints running false with --json when nothing is running', async () => {
    const { lines, log } = capture();

    await runStatus(JSON_ARGS, {
      readState: () => Promise.resolve(null),
      removeState: noop,
      controller: new FakeProcessController(),
      probeHealth: healthy,
      log,
      now: () => 0,
    });

    expect(JSON.parse(lines.join(''))).toEqual({ running: false });
    // One command, one format: the running answer above is pretty-printed, and
    // anything diffing or line-parsing `status --json` would otherwise have to
    // handle two shapes for one contract.
    expect(lines.join('')).toBe(JSON.stringify({ running: false }, null, 2));
  });
});
