import { describe, expect, it } from 'bun:test';
import { browserCommand, runOpen } from '../../../../src/cli/commands/open';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: '0.0.0.0',
  startedAt: 0,
  logFile: '',
  version: 't',
};

describe('runOpen', () => {
  it('opens the loopback address of a bind-all server', async () => {
    const opened: string[] = [];
    const lines: string[] = [];
    await runOpen({
      controller: new FakeProcessController([42]),
      readState: () => Promise.resolve(STATE),
      removeState: () => Promise.resolve(),
      log: (msg) => lines.push(msg),
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    expect(opened).toEqual(['http://localhost:3001']);
    expect(lines).toEqual(['Opened http://localhost:3001']);
  });

  it('refuses when nothing is running', async () => {
    await expect(
      runOpen({
        controller: new FakeProcessController(),
        readState: () => Promise.resolve(null),
        openUrl: () => Promise.resolve(),
      })
    ).rejects.toThrow(/not running/);
  });
});

describe('browserCommand', () => {
  it('picks the platform opener', () => {
    expect(browserCommand('darwin', 'http://x')).toEqual(['open', 'http://x']);
    expect(browserCommand('win32', 'http://x')).toEqual(['cmd', '/c', 'start', '', 'http://x']);
    expect(browserCommand('linux', 'http://x')).toEqual(['xdg-open', 'http://x']);
  });
});
