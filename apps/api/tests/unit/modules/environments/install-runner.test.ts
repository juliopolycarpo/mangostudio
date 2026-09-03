/**
 * The hub half of an install: it asks a machine to run an argv it built and
 * relays that machine's output frames back onto the stream a browser reads.
 * Execution itself lives in `apps/runtime`; what is tested here is the seam.
 */

import { describe, expect, it } from 'bun:test';
import { RUNTIME_INSTALL_OUTPUT_TOPIC, type RuntimeInstallRunResult } from '@mangostudio/runtime';
import type { RuntimeEventFrame } from '@mangostudio/shared/runtime-protocol';
import {
  createInstallRunner,
  type InstallLogLine,
} from '../../../../src/modules/environments/infrastructure/install-runner';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

const COMMAND = {
  runId: 'run-1',
  userId: 'ada',
  environmentId: 'ubuntu',
  argv: ['echo', 'hello'],
  timeoutMs: 1_000,
} as const;

const SUCCESS: RuntimeInstallRunResult = {
  exitCode: 0,
  status: 'succeeded',
  truncated: false,
  finishedAt: 1_700_000_001_000,
  durationMs: 1_000,
};

interface FakeClientOptions {
  readonly result?: RuntimeInstallRunResult | (() => Promise<RuntimeInstallRunResult>);
  /** Frames the runtime publishes once `install.run` has been called. */
  readonly frames?: readonly Partial<RuntimeEventFrame>[];
}

function fakeClient(options: FakeClientOptions = {}) {
  const listeners = new Set<(event: RuntimeEventFrame) => void>();
  const cancelled: string[] = [];
  const runParams: unknown[] = [];

  const client = {
    onEvent: (listener: (event: RuntimeEventFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    install: {
      run: (params: unknown) => {
        runParams.push(params);
        for (const frame of options.frames ?? []) {
          for (const listener of [...listeners]) {
            listener({
              type: 'evt',
              seq: 0,
              topic: '',
              payload: {},
              ...frame,
            } as RuntimeEventFrame);
          }
        }
        const result = options.result ?? SUCCESS;
        return typeof result === 'function' ? result() : Promise.resolve(result);
      },
      cancel: ({ runId }: { runId: string }) => {
        cancelled.push(runId);
        return Promise.resolve({ ok: true as const });
      },
    },
  } as unknown as RuntimeClient;

  return { client, cancelled, runParams, listenerCount: () => listeners.size };
}

function runnerFor(client: RuntimeClient) {
  return createInstallRunner({
    resolveClient: () => Promise.resolve(client),
    logPathFor: (runId) => `/logs/${runId}.log`,
    now: () => 1_700_000_000_000,
  });
}

describe('install relay', () => {
  it('turns the runtime output frames for this run into log lines', async () => {
    const fake = fakeClient({
      frames: [
        {
          topic: RUNTIME_INSTALL_OUTPUT_TOPIC,
          streamId: 'run-1',
          payload: { stream: 'stdout', line: 'hello' },
        },
        {
          topic: RUNTIME_INSTALL_OUTPUT_TOPIC,
          streamId: 'run-1',
          payload: { stream: 'stderr', line: 'warning' },
        },
        // The terminal marker closes the stream; it is not a line to show.
        {
          topic: RUNTIME_INSTALL_OUTPUT_TOPIC,
          streamId: 'run-1',
          payload: { stream: 'system', line: '', end: true },
        },
      ],
    });
    const events: InstallLogLine[] = [];

    const result = await runnerFor(fake.client).run(COMMAND, {
      onLog: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(events).toEqual([
      { stream: 'stdout', line: 'hello' },
      { stream: 'stderr', line: 'warning' },
    ]);
  });

  it("forwards the recipe's accepted exit codes to the runtime", async () => {
    const fake = fakeClient();

    await runnerFor(fake.client).run({ ...COMMAND, acceptedExitCodes: [-1978335189] });

    expect(fake.runParams).toEqual([expect.objectContaining({ acceptedExitCodes: [-1978335189] })]);
  });

  it('omits acceptedExitCodes entirely when the recipe declares none', async () => {
    const fake = fakeClient();

    await runnerFor(fake.client).run(COMMAND);

    expect(fake.runParams[0]).not.toHaveProperty('acceptedExitCodes');
  });

  it('ignores frames belonging to another run or another topic', async () => {
    const fake = fakeClient({
      frames: [
        {
          topic: RUNTIME_INSTALL_OUTPUT_TOPIC,
          streamId: 'run-2',
          payload: { stream: 'stdout', line: 'someone else' },
        },
        { topic: 'mcp.session', streamId: 'run-1', payload: { stream: 'stdout', line: 'nope' } },
      ],
    });
    const events: InstallLogLine[] = [];

    await runnerFor(fake.client).run(COMMAND, { onLog: (event) => events.push(event) });

    expect(events).toEqual([]);
  });

  it('releases its subscription once the run settles', async () => {
    const fake = fakeClient();

    await runnerFor(fake.client).run(COMMAND);

    expect(fake.listenerCount()).toBe(0);
  });

  it('asks the runtime to cancel rather than signalling a child it does not own', async () => {
    const controller = new AbortController();
    let settle: ((result: RuntimeInstallRunResult) => void) | undefined;
    const fake = fakeClient({
      result: () =>
        new Promise<RuntimeInstallRunResult>((resolve) => {
          settle = resolve;
        }),
    });

    const running = runnerFor(fake.client).run(COMMAND, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    settle?.({ ...SUCCESS, exitCode: null, status: 'cancelled' });

    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(fake.cancelled).toEqual(['run-1']);
  });

  it('never starts a run whose request was already abandoned', async () => {
    const fake = fakeClient();
    const controller = new AbortController();
    controller.abort();

    const result = await runnerFor(fake.client).run(COMMAND, { signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(fake.runParams).toEqual([]);
  });

  it('reports an unreachable environment as a failed spawn with the reason', async () => {
    const events: InstallLogLine[] = [];
    const runner = createInstallRunner({
      resolveClient: () => Promise.reject(new Error('Environment "ubuntu" is disabled.')),
      now: () => 1_700_000_000_000,
    });

    const result = await runner.run(COMMAND, { onLog: (event) => events.push(event) });

    expect(result.status).toBe('spawn-failed');
    expect(events).toEqual([{ stream: 'system', line: 'Environment "ubuntu" is disabled.' }]);
  });

  it('does not claim an installer never started when the link dropped mid-run', async () => {
    const fake = fakeClient({ result: () => Promise.reject(new Error('Runtime went away.')) });
    const events: InstallLogLine[] = [];

    const result = await runnerFor(fake.client).run(COMMAND, {
      onLog: (event) => events.push(event),
    });

    // `spawn-failed` would be a claim about the far side that the hub cannot
    // make once the request was accepted.
    expect(result.status).toBe('failed');
    expect(events).toEqual([{ stream: 'system', line: 'Runtime went away.' }]);
  });
});
