import { describe, expect, it } from 'bun:test';
import { type HubProcessStatus, HubProcessStatusSchema } from '@mangostudio/shared/machine';
import Value from 'typebox/value';
import { runStatus } from '../../../../src/cli/commands/status';
import type { ServerState } from '../../../../src/lib/server-state';
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
    });

    expect(lines.join('\n')).toContain('Health:  unreachable');
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
  });
});
