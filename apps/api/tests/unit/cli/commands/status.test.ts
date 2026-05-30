import { describe, expect, it } from 'bun:test';
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
};

function capture(): { lines: string[]; log: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, log: (msg) => lines.push(msg) };
}

const noop = (): Promise<void> => Promise.resolve();

describe('runStatus', () => {
  it('reports not running when there is no state', async () => {
    const { lines, log } = capture();

    await runStatus({
      readState: () => Promise.resolve(null),
      removeState: noop,
      controller: new FakeProcessController(),
      probeHealth: () => Promise.resolve(false),
      log,
      now: () => 0,
    });

    expect(lines).toEqual(['MangoStudio is not running.']);
  });

  it('cleans up a stale state file', async () => {
    const { lines, log } = capture();
    let removed = false;

    await runStatus({
      readState: () => Promise.resolve(STATE),
      removeState: () => {
        removed = true;
        return Promise.resolve();
      },
      controller: new FakeProcessController([]),
      probeHealth: () => Promise.resolve(false),
      log,
      now: () => 0,
    });

    expect(removed).toBe(true);
    expect(lines[0]).toBe('MangoStudio is not running.');
  });

  it('prints details for a healthy running instance', async () => {
    const { lines, log } = capture();

    await runStatus({
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: () => Promise.resolve(true),
      log,
      now: () => 5000,
    });

    const text = lines.join('\n');
    expect(text).toContain('MangoStudio is running.');
    expect(text).toContain('PID:     42');
    expect(text).toContain('Uptime:  5s');
    expect(text).toContain('Health:  ok');
  });

  it('shows health unreachable when the probe fails', async () => {
    const { lines, log } = capture();

    await runStatus({
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller: new FakeProcessController([42]),
      probeHealth: () => Promise.resolve(false),
      log,
      now: () => 0,
    });

    expect(lines.join('\n')).toContain('Health:  unreachable');
  });
});
