import { describe, expect, it } from 'bun:test';
import { runPruneRetry } from '../../../../src/modules/updates/application/prune-retry';
import type { InstallOriginProbe } from '../../../../src/modules/updates/domain/install-origin';
import type {
  RunScript,
  RunScriptOptions,
  ScriptOutputLine,
} from '../../../../src/modules/updates/infrastructure/run-script';

const DIST_ROOT = 'C:\\Users\\j\\AppData\\Local\\mangostudio';

const ORIGIN_RECORD_WITH_PENDING = JSON.stringify({
  origin: 'installer',
  channel: 'stable',
  version: '0.1.1',
  prunePending: ['0.4.0'],
});

const ORIGIN_RECORD_WITHOUT_PENDING = JSON.stringify({
  origin: 'installer',
  channel: 'stable',
  version: '0.1.1',
});

function windowsProbe(record: string): InstallOriginProbe {
  return {
    platform: 'win32',
    env: {},
    execPath: `${DIST_ROOT}\\0.1.1\\mangostudio.exe`,
    version: '0.1.1',
    standalone: true,
    container: false,
    home: 'C:\\Users\\j',
    localAppData: DIST_ROOT.replace('\\mangostudio', ''),
    readFile: (path) => (path === `${DIST_ROOT}\\install-origin.json` ? record : null),
  };
}

const NO_LINES: AsyncIterable<ScriptOutputLine> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
};

/** Yields nothing and exits clean — enough to drive `runPruneRetry` without a real process. */
function fakeScriptRun(exitCode: number): {
  lines: AsyncIterable<ScriptOutputLine>;
  exitCode: Promise<number>;
} {
  return { lines: NO_LINES, exitCode: Promise.resolve(exitCode) };
}

describe('runPruneRetry', () => {
  it('does nothing when nothing is pending — never writes or spawns anything', async () => {
    const runCalls: Array<{ argv: readonly string[]; options: RunScriptOptions }> = [];
    const writeCalls: string[] = [];
    const runScript: RunScript = (argv, options) => {
      runCalls.push({ argv, options });
      return fakeScriptRun(0);
    };

    await runPruneRetry({
      platform: 'win32',
      probe: () => windowsProbe(ORIGIN_RECORD_WITHOUT_PENDING),
      runScript,
      which: () => null,
      writeScript: (directory) => {
        writeCalls.push(directory);
        return Promise.resolve(`${directory}\\install.ps1`);
      },
      mkdir: () => Promise.resolve(),
      removeDir: () => Promise.resolve(),
    });

    expect(runCalls).toEqual([]);
    expect(writeCalls).toEqual([]);
  });

  it('never retries on POSIX even with prunePending recorded', async () => {
    const runCalls: unknown[] = [];
    const runScript: RunScript = (argv, options) => {
      runCalls.push({ argv, options });
      return fakeScriptRun(0);
    };
    const posixProbe: InstallOriginProbe = {
      platform: 'linux',
      env: {},
      execPath: '/home/j/.mango/dist/0.1.1/mangostudio',
      version: '0.1.1',
      standalone: true,
      container: false,
      home: '/home/j',
      readFile: (path) =>
        path === '/home/j/.mango/dist/install-origin.json' ? ORIGIN_RECORD_WITH_PENDING : null,
    };

    let probeCalls = 0;

    await runPruneRetry({
      platform: 'linux',
      probe: () => {
        probeCalls += 1;
        return posixProbe;
      },
      runScript,
      which: () => null,
    });

    expect(runCalls).toEqual([]);
    // The guard is ahead of the probe: this hook runs on the startup tick of
    // every hub, and the probe is a realpath plus an install-origin.json read.
    expect(probeCalls).toBe(0);
  });

  it('runs the embedded script with -Prune and the install dir env, then cleans up', async () => {
    const runCalls: Array<{ argv: readonly string[]; options: RunScriptOptions }> = [];
    const removeCalls: string[] = [];
    const runScript: RunScript = (argv, options) => {
      runCalls.push({ argv, options });
      return fakeScriptRun(0);
    };

    await runPruneRetry({
      platform: 'win32',
      probe: () => windowsProbe(ORIGIN_RECORD_WITH_PENDING),
      runScript,
      which: () => 'C:\\pwsh\\pwsh.exe',
      writeScript: (directory) => Promise.resolve(`${directory}\\install.ps1`),
      mkdir: () => Promise.resolve(),
      removeDir: (directory) => {
        removeCalls.push(directory);
        return Promise.resolve();
      },
    });

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.argv).toContain('-Prune');
    expect(runCalls[0]?.argv).toContain('-File');
    expect(runCalls[0]?.options.env.MANGOSTUDIO_INSTALL_DIR).toBe(DIST_ROOT);
    expect(removeCalls).toHaveLength(1);
  });

  it('still cleans up its temp directory when the script exits non-zero', async () => {
    const removeCalls: string[] = [];
    const runScript: RunScript = () => fakeScriptRun(1);

    await runPruneRetry({
      platform: 'win32',
      probe: () => windowsProbe(ORIGIN_RECORD_WITH_PENDING),
      runScript,
      which: () => null,
      writeScript: (directory) => Promise.resolve(`${directory}\\install.ps1`),
      mkdir: () => Promise.resolve(),
      removeDir: (directory) => {
        removeCalls.push(directory);
        return Promise.resolve();
      },
    });

    expect(removeCalls).toHaveLength(1);
  });

  it('never rejects when its own temp-directory cleanup fails', async () => {
    // The catch above sits inside the try, so a throw from the finally's
    // cleanup escapes the function — and the only caller is `void
    // runPruneRetry()` on the startup tick, where that is an unhandled
    // rejection that takes the hub down.
    const runScript: RunScript = () => fakeScriptRun(0);

    await expect(
      runPruneRetry({
        platform: 'win32',
        probe: () => windowsProbe(ORIGIN_RECORD_WITH_PENDING),
        runScript,
        which: () => null,
        writeScript: (directory) => Promise.resolve(`${directory}\\install.ps1`),
        mkdir: () => Promise.resolve(),
        removeDir: () => Promise.reject(new Error('EPERM: operation not permitted')),
      })
    ).resolves.toBeUndefined();
  });
});
