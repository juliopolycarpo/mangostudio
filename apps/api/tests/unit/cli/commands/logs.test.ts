import { describe, expect, it } from 'bun:test';
import { type LogsDeps, runLogs } from '../../../../src/cli/commands/logs';
import { type LogTail, tailLines } from '../../../../src/cli/log-tail';
import type { ServerState } from '../../../../src/lib/server-state';

/** What a real `readLogTail` returns for content that fits inside the budget. */
function tail(content: string, count: number): LogTail {
  return { ...tailLines(content, count), offset: Buffer.byteLength(content) };
}

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: 'localhost',
  startedAt: 0,
  logFile: '/logs/server-1.log',
  version: 't',
};

function baseDeps(overrides: Partial<LogsDeps> = {}) {
  const lines: string[] = [];
  const chunks: string[] = [];
  const deps: Partial<LogsDeps> = {
    readState: () => Promise.resolve(STATE),
    latestLogFile: () => Promise.resolve(null),
    readTail: (_path, count) => Promise.resolve(tail('one\ntwo\nthree\n', count)),
    log: (msg) => lines.push(msg),
    write: (chunk) => chunks.push(chunk),
    ...overrides,
  };
  return { deps, lines, chunks };
}

describe('runLogs', () => {
  it('prints the last lines of the recorded log file', async () => {
    const { deps, lines } = baseDeps();
    await runLogs({ follow: false, lines: 2 }, deps);
    expect(lines).toEqual(['two\nthree']);
  });

  it('falls back to the newest log when no state file names one', async () => {
    const asked: string[] = [];
    const { deps, lines } = baseDeps({
      readState: () => Promise.resolve(null),
      latestLogFile: () => Promise.resolve('/logs/service.log'),
      readTail: (path, count) => {
        asked.push(path);
        return Promise.resolve(tail('tail\n', count));
      },
    });
    await runLogs({ follow: false, lines: 100 }, deps);
    expect(asked).toEqual(['/logs/service.log']);
    expect(lines).toEqual(['tail']);
  });

  it('explains a foreground start has no file', async () => {
    const { deps } = baseDeps({ readState: () => Promise.resolve({ ...STATE, logFile: '' }) });
    await expect(runLogs({ follow: false, lines: 10 }, deps)).rejects.toThrow(
      /No log file to show/
    );
  });

  it('names a recorded file that is gone', async () => {
    const { deps } = baseDeps({ readTail: () => Promise.resolve(null) });
    await expect(runLogs({ follow: false, lines: 10 }, deps)).rejects.toThrow(
      'Log file not found: /logs/server-1.log'
    );
  });

  it('follows appended bytes from the end of what it printed', async () => {
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let size = 14;
    const { deps, chunks } = baseDeps({
      follow: {
        size: () => Promise.resolve(size),
        readFrom: (_path, offset) => Promise.resolve(`from ${offset}`),
        sleep: () => {
          if (size === 14) {
            size = 20;
            return Promise.resolve();
          }
          stop();
          return Promise.resolve();
        },
        stopped,
      },
    });
    await runLogs({ follow: true, lines: 100 }, deps);
    expect(chunks).toEqual(['from 14']);
  });
});
