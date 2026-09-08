/**
 * `setup` is the one command a person runs before they know anything about the
 * others, so what it must never do is more important than what it does: it must
 * not restart a hub that is already serving, must not decide on its own whether
 * to install a service unit, and must not say it opened a browser on a machine
 * that has no display.
 */

import { describe, expect, it } from 'bun:test';
import type { ServeArgs, ServiceArgs, SetupArgs } from '../../../../src/cli/args';
import { canOpenBrowser, runSetup, type SetupDeps } from '../../../../src/cli/commands/setup';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const LIVE: ServerState = {
  pid: 42,
  port: 3001,
  host: '127.0.0.1',
  startedAt: 0,
  logFile: '',
  version: 't',
};

/** Records what a run started, so a test can assert on the absence of a start. */
class FakeLauncher {
  readonly serviceCalls: ServiceArgs[] = [];
  readonly serveCalls: ServeArgs[] = [];

  runService = (args: ServiceArgs): Promise<void> => {
    this.serviceCalls.push(args);
    return Promise.resolve();
  };

  runServe = (args: ServeArgs): Promise<void> => {
    this.serveCalls.push(args);
    return Promise.resolve();
  };
}

/** A state file that answers with nothing until something claims to start a hub. */
class FakeHubState {
  private state: ServerState | null;
  readonly removals: number[] = [];

  constructor(initial: ServerState | null) {
    this.state = initial;
  }

  appear(state: ServerState = LIVE): void {
    this.state = state;
  }

  readState = (): Promise<ServerState | null> => Promise.resolve(this.state);

  removeState = (): Promise<void> => {
    this.removals.push(1);
    this.state = null;
    return Promise.resolve();
  };
}

function args(overrides: Partial<SetupArgs> = {}): SetupArgs {
  return { open: true, ...overrides };
}

function advancingClock(stepMs = 500): () => number {
  let elapsed = 0;
  return () => {
    elapsed += stepMs;
    return elapsed;
  };
}

function deps(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
  return {
    controller: new FakeProcessController([42]),
    ensureAuthSecret: () => Promise.resolve(),
    confirmsHealthy: () => Promise.resolve(true),
    isInteractive: () => false,
    promptYesNo: () => Promise.resolve(false),
    openUrl: () => Promise.resolve(),
    platform: 'linux',
    env: { DISPLAY: ':0' },
    sleep: () => Promise.resolve(),
    // Advances on every read, so a test that never produces a hub fails on the
    // command's own deadline instead of spinning.
    now: advancingClock(),
    ...overrides,
  };
}

describe('runSetup', () => {
  it('reuses a hub that is already serving instead of starting another', async () => {
    const launcher = new FakeLauncher();
    const lines: string[] = [];
    const opened: string[] = [];

    await runSetup(
      args(),
      deps({
        readState: () => Promise.resolve(LIVE),
        log: (line) => lines.push(line),
        openUrl: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
        runService: launcher.runService,
        runServe: launcher.runServe,
      })
    );

    expect(launcher.serviceCalls).toEqual([]);
    expect(launcher.serveCalls).toEqual([]);
    expect(lines[0]).toContain('already running');
    expect(opened).toEqual(['http://127.0.0.1:3001']);
  });

  it('clears a state file left by a crashed hub and starts a new one', async () => {
    // The file names a pid nothing is running under; the hub that replaces it
    // takes a live one.
    const state = new FakeHubState({ ...LIVE, pid: 99 });
    const launcher = new FakeLauncher();

    await runSetup(
      args({ service: false }),
      deps({
        readState: state.readState,
        removeState: () => {
          void state.removeState();
          state.appear();
          return Promise.resolve();
        },
        log: () => undefined,
        runService: launcher.runService,
        runServe: launcher.runServe,
      })
    );

    expect(state.removals).toHaveLength(1);
    expect(launcher.serveCalls).toEqual([{ detached: true }]);
  });

  it('installs the service when asked to, and starts nothing else', async () => {
    const state = new FakeHubState(null);
    const launcher = new FakeLauncher();

    await runSetup(
      args({ service: true, port: 4000 }),
      deps({
        readState: () => {
          const answer = state.readState();
          state.appear();
          return answer;
        },
        log: () => undefined,
        runService: launcher.runService,
        runServe: launcher.runServe,
      })
    );

    expect(launcher.serviceCalls).toEqual([{ action: 'install', json: false, port: 4000 }]);
    expect(launcher.serveCalls).toEqual([]);
  });

  it('refuses to choose about the service when there is nobody to ask', async () => {
    await expect(
      runSetup(
        args(),
        deps({
          readState: () => Promise.resolve(null),
          isInteractive: () => false,
          log: () => undefined,
        })
      )
    ).rejects.toThrow(/--service or --no-service/);
  });

  it('asks about the service when a terminal is attached', async () => {
    const state = new FakeHubState(null);
    const launcher = new FakeLauncher();
    const questions: string[] = [];

    await runSetup(
      args(),
      deps({
        readState: () => {
          const answer = state.readState();
          state.appear();
          return answer;
        },
        isInteractive: () => true,
        promptYesNo: (question) => {
          questions.push(question);
          return Promise.resolve(true);
        },
        log: () => undefined,
        runService: launcher.runService,
        runServe: launcher.runServe,
      })
    );

    expect(questions).toHaveLength(1);
    expect(launcher.serviceCalls).toHaveLength(1);
  });

  it('gives up with a readable reason when the hub it started never answers', async () => {
    await expect(
      runSetup(
        args({ service: false }),
        deps({
          readState: () => Promise.resolve(null),
          log: () => undefined,
          runServe: () => Promise.resolve(),
        })
      )
    ).rejects.toThrow(/never answered its health check/);
  });

  it('prints connection guidance instead of claiming a browser opened', async () => {
    const lines: string[] = [];
    const opened: string[] = [];

    await runSetup(
      args(),
      deps({
        readState: () => Promise.resolve(LIVE),
        env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' },
        log: (line) => lines.push(line),
        openUrl: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      })
    );

    expect(opened).toEqual([]);
    expect(lines.join('\n')).toContain('http://127.0.0.1:3001');
    expect(lines.join('\n')).toContain('ssh -L 3001:localhost:3001');
  });

  it('still names the address when opening a browser fails', async () => {
    const lines: string[] = [];

    await runSetup(
      args(),
      deps({
        readState: () => Promise.resolve(LIVE),
        log: (line) => lines.push(line),
        openUrl: () => Promise.reject(new Error('no opener')),
      })
    );

    expect(lines.join('\n')).toContain('http://127.0.0.1:3001');
  });

  it('prints the address and opens nothing with --no-open', async () => {
    const lines: string[] = [];
    const opened: string[] = [];

    await runSetup(
      args({ open: false }),
      deps({
        readState: () => Promise.resolve(LIVE),
        log: (line) => lines.push(line),
        openUrl: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      })
    );

    expect(opened).toEqual([]);
    expect(lines.join('\n')).toContain('http://127.0.0.1:3001');
  });
});

describe('canOpenBrowser', () => {
  it('trusts the desktop on macOS and Windows', () => {
    expect(canOpenBrowser('darwin', {})).toBe(true);
    expect(canOpenBrowser('win32', {})).toBe(true);
  });

  it('needs a display on Linux', () => {
    expect(canOpenBrowser('linux', {})).toBe(false);
    expect(canOpenBrowser('linux', { DISPLAY: ':0' })).toBe(true);
    expect(canOpenBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });
});
