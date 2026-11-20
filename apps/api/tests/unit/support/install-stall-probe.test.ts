import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  describeInstallStall,
  explainStalledWait,
  type InstallStallProbeOptions,
  stallProbeLogPath,
} from '../../support/install-stall-probe';

type RunBehaviour = 'already-active' | 'accepts' | 'silent';

/** A runtime whose `runtime.health` and duplicate `install.run` answers are chosen per test. */
class FakeStallRuntime {
  readonly runCalls: Array<{ runId: string; argv: string[] }> = [];

  constructor(
    private readonly health: 'answers' | 'silent',
    private readonly run: RunBehaviour
  ) {}

  readonly install = {
    run: (params: { runId: string; argv: string[] }): Promise<unknown> => {
      this.runCalls.push({ runId: params.runId, argv: params.argv });
      if (this.run === 'accepts') return Promise.resolve({ status: 'succeeded' });
      if (this.run === 'already-active') {
        return Promise.reject(
          new Error(`runId="${params.runId}": expected a run id that is not already active`)
        );
      }
      return Promise.reject(new Error('request timed out'));
    },
  };

  healthCall = (): Promise<unknown> =>
    this.health === 'answers'
      ? Promise.resolve({})
      : Promise.reject(new Error('request timed out'));

  asClient(): InstallStallProbeOptions['runtime'] {
    return { health: this.healthCall, install: this.install } as unknown as Pick<
      RuntimeClient,
      'health' | 'install'
    >;
  }
}

function probeOptions(
  runtime: FakeStallRuntime,
  overrides: Partial<InstallStallProbeOptions> = {}
): InstallStallProbeOptions {
  return {
    runtime: runtime.asClient(),
    runtimePid: () => process.pid,
    runtimeStderr: () => 'mangostudio-runtime: boom',
    runId: 'run-under-test',
    startedAt: 1_000,
    now: () => 4_500,
    probeLogPath: join(tmpdir(), 'stall-probe.log'),
    listProcesses: () => Promise.resolve('powershell.exe 4242 CPU 0:00:00'),
    ...overrides,
  };
}

describe('describeInstallStall', () => {
  it('reports a runtime that holds the run id, answers health and has a quiet installer', async () => {
    const runtime = new FakeStallRuntime('answers', 'already-active');
    const text = await describeInstallStall(probeOptions(runtime), 'linux');

    expect(text).toContain('sinceRunStartMs=3500');
    expect(text).toContain(`runtime pid ${process.pid} is alive`);
    expect(text).toContain('runtime.health answered');
    expect(text).toContain('the runtime holds the run id (the request reached the handler)');
    expect(text).toContain('powershell.exe 4242 CPU 0:00:00');
    expect(text).toContain('mangostudio-runtime: boom');
    expect(runtime.runCalls).toEqual([{ runId: 'run-under-test', argv: ['sh', '-c', 'true'] }]);
  });

  it('says the request never reached the handler when the duplicate run is accepted', async () => {
    const text = await describeInstallStall(
      probeOptions(new FakeStallRuntime('answers', 'accepts')),
      'win32'
    );

    expect(text).toContain('the runtime had not reserved the run id');
  });

  it('names a runtime that answers neither health nor the duplicate run', async () => {
    const text = await describeInstallStall(
      probeOptions(new FakeStallRuntime('silent', 'silent')),
      'linux'
    );

    expect(text).toContain('runtime.health did not answer within 2000ms');
    expect(text).toContain('the duplicate run got no usable answer within 2000ms');
  });

  it('uses a cmd.exe no-op for the duplicate run on Windows', async () => {
    const runtime = new FakeStallRuntime('answers', 'accepts');
    await describeInstallStall(probeOptions(runtime), 'win32');

    expect(runtime.runCalls[0]?.argv).toEqual(['cmd.exe', '/d', '/c', 'exit 0']);
  });

  it('keeps the diagnosis when the process listing fails', async () => {
    const text = await describeInstallStall(
      probeOptions(new FakeStallRuntime('answers', 'already-active'), {
        listProcesses: () => Promise.reject(new Error('tasklist missing')),
      }),
      'linux'
    );

    expect(text).toContain('process listing failed (tasklist missing)');
  });

  it('puts the duplicate run log beside the run log', () => {
    expect(stallProbeLogPath(join('scratch', 'run.log'))).toBe(join('scratch', 'stall-probe.log'));
  });
});

describe('explainStalledWait', () => {
  it('appends the diagnosis, releases the installer, and keeps the original message', async () => {
    const order: string[] = [];
    const error = new Error('expected a relayed stdout line containing "waiting"');
    await explainStalledWait(error, {
      diagnose: () => {
        order.push('diagnose');
        return Promise.resolve('fake diagnosis text');
      },
      release: () => {
        order.push('release');
        return Promise.resolve();
      },
    });

    expect(error.message).toBe(
      'expected a relayed stdout line containing "waiting"; stall probe: fake diagnosis text'
    );
    expect(order).toEqual(['diagnose', 'release']);
  });

  it('reports a failing diagnosis and still releases when release rejects', async () => {
    const error = new Error('base');
    await explainStalledWait(error, {
      diagnose: () => Promise.reject(new Error('probe exploded')),
      release: () => Promise.reject(new Error('EBUSY')),
    });

    expect(error.message).toBe('base; stall probe: probe failed: Error: probe exploded');
  });

  it('leaves the message alone without a diagnosis but still releases', async () => {
    const error = new Error('base');
    let released = false;
    await explainStalledWait(error, {
      release: () => {
        released = true;
        return Promise.resolve();
      },
    });

    expect(error.message).toBe('base');
    expect(released).toBe(true);
  });
});
