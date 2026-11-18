/**
 * `spawnRuntimeChild` reads why a launch failed from the SDK launcher's
 * `startError()`, and the handshake deadline is the session's alone.
 */

import { describe, expect, it } from 'bun:test';

import { CLOSE_CODES, RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import type { ExitStatus, LaunchedPeer, SpawnStartError } from '@mangostudio/protocol/spawn';

import {
  type RuntimeLaunchFailure,
  spawnRuntimeChild,
  type SpawnRuntimeChildOptions,
} from '../../../src/services/runtime-client/spawn-runtime-child';
import { DeferredSpawnPort } from '../../support/mocks/deferred-spawn-port';

interface ScriptedLaunch {
  /** What the launcher's `startError()` reports. */
  readonly start: SpawnStartError;
  readonly stderr: string;
  /** Whether the child's pipe closes at once, as a wrapper that could not start its target does. */
  readonly closesAtOnce: boolean;
}

/**
 * A launcher whose child never says hello. `exited` never settles, so a
 * report of the exit status can only have come from `startError()`.
 */
class ScriptedLauncher {
  readonly startErrorGraces: (number | undefined)[] = [];
  terminateCalls = 0;
  spawnedPid: number | undefined;

  constructor(private readonly script: ScriptedLaunch) {}

  readonly spawnPort = (): LaunchedPeer => {
    const { a, b } = createInProcessPortPair();
    if (this.script.closesAtOnce) {
      queueMicrotask(() => b.close(CLOSE_CODES.RELEASED, 'child exited before hello'));
    }
    const never = new Promise<ExitStatus>(() => undefined);
    const terminated: ExitStatus = { code: null, signal: 'SIGTERM' };
    return {
      port: a,
      pid: this.script.start.spawnErrorCode === undefined ? 4321 : undefined,
      exited: never,
      stderrTail: () => this.script.stderr,
      startError: (graceMs) => {
        this.startErrorGraces.push(graceMs);
        return Promise.resolve(this.script.start);
      },
      setTerminateGraceMs: () => true,
      terminate: () => {
        this.terminateCalls += 1;
        b.close(CLOSE_CODES.RELEASED, 'terminated by the launcher');
        return Promise.resolve(terminated);
      },
    };
  };
}

function launchOptions(
  overrides: Partial<SpawnRuntimeChildOptions> = {}
): SpawnRuntimeChildOptions {
  return {
    environmentId: 'devbox',
    launch: { command: 'fake-runtime', args: [] },
    workspaceBinding: null,
    hubVersion: 'hub-test',
    onClosed: () => undefined,
    ...overrides,
  };
}

describe('spawnRuntimeChild — launch failure from startError', () => {
  it('names the missing binary when the launcher reports ENOENT', async () => {
    const launcher = new ScriptedLauncher({
      start: {
        exit: { code: null, signal: null },
        spawnErrorCode: 'ENOENT',
        stderrLine: 'spawn fake-runtime ENOENT',
      },
      stderr: 'spawn fake-runtime ENOENT',
      closesAtOnce: true,
    });

    const error = await spawnRuntimeChild(launchOptions(), { spawnPort: launcher.spawnPort }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({
      code: RESERVED_ERROR_CODES.UNAVAILABLE,
      message:
        'The runtime binary was not found at fake-runtime. Reinstall MangoStudio so it ships beside the hub, or set a binary path on this environment.',
    });
    expect(launcher.terminateCalls).toBe(1);
  });

  it('hands a wrapper the exit status startError observed, not one the hub raced for', async () => {
    const launcher = new ScriptedLauncher({
      start: {
        exit: { code: 255, signal: null },
        spawnErrorCode: undefined,
        stderrLine: 'ssh: connect to host devbox port 22: Connection refused',
      },
      stderr: 'ssh: connect to host devbox port 22: Connection refused\n',
      closesAtOnce: true,
    });
    const seen: RuntimeLaunchFailure[] = [];

    const error = await spawnRuntimeChild(
      launchOptions({
        describeFailure: (failure) => {
          seen.push(failure);
          return 'wrapper says: refused';
        },
      }),
      { spawnPort: launcher.spawnPort }
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect((error as Error).message).toBe('wrapper says: refused');
    expect(seen).toHaveLength(1);
    expect({
      command: seen[0]?.command,
      exitCode: seen[0]?.exitCode,
      spawnErrorCode: seen[0]?.spawnErrorCode,
      stderr: seen[0]?.stderr,
    }).toEqual({
      command: 'fake-runtime',
      exitCode: 255,
      spawnErrorCode: undefined,
      stderr: 'ssh: connect to host devbox port 22: Connection refused\n',
    });
  });

  it('reports a null exit code when startError saw no exit land', async () => {
    const launcher = new ScriptedLauncher({
      start: { exit: undefined, spawnErrorCode: undefined, stderrLine: '' },
      stderr: '',
      closesAtOnce: true,
    });
    const seen: RuntimeLaunchFailure[] = [];

    await spawnRuntimeChild(
      launchOptions({
        describeFailure: (failure) => {
          seen.push(failure);
          return undefined;
        },
      }),
      { spawnPort: launcher.spawnPort }
    ).catch(() => undefined);

    expect(seen.map((failure) => failure.exitCode)).toEqual([null]);
  });

  it('expires on the session handshake deadline alone and reads startError once, on its default grace', async () => {
    const launcher = new ScriptedLauncher({
      start: { exit: undefined, spawnErrorCode: undefined, stderrLine: 'still booting' },
      stderr: 'still booting',
      closesAtOnce: false,
    });

    const error = await spawnRuntimeChild(launchOptions({ handshakeTimeoutMs: 20 }), {
      spawnPort: launcher.spawnPort,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect((error as Error).message).toContain(
      'The runtime at fake-runtime did not complete its handshake:'
    );
    expect((error as Error).message).toContain('Runtime stderr:\nstill booting');
    // One grace, the launcher's: a hub-side wait would pass its own number.
    expect(launcher.startErrorGraces).toEqual([undefined]);
    expect(launcher.terminateCalls).toBe(1);
  });

  it('never asks startError about a launch that handshakes', async () => {
    const fake = new DeferredSpawnPort();
    const attempt = spawnRuntimeChild(launchOptions(), { spawnPort: fake.spawnPort });
    fake.release();

    const connection = await attempt;
    await connection.close();

    expect(fake.startErrorCallCount).toBe(0);
  });
});
