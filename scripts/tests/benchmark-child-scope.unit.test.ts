import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BenchmarkChildScope,
  benchmarkResourceCleanupError,
  type BenchmarkScopeHost,
  pumpBenchmarkStream,
  recordBenchmarkCleanup,
  settleBenchmarkWork,
} from '../bench/benchmark-child-scope';
import {
  type NativeProcess,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';
import type { ProcessResourceObservation } from '../lib/process-resource-monitor';
import { fixtureChildEnvironment } from './support/child-supervision';

const root: NativeProcess = {
  pid: 42,
  parentPid: 10,
  group: 42,
  identity: '42:1',
  command: 'fixture',
};

class FakeScopeHost implements BenchmarkScopeHost {
  readonly platform = 'linux';
  readonly parentPid = 10;
  readonly signals: number[] = [];
  readonly snapshots: Array<readonly NativeProcess[] | Error> = [];
  running = true;
  clock = 0;
  private resolveExit!: () => void;
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  snapshot(): Promise<readonly NativeProcess[]> {
    const next = this.snapshots.shift() ?? [];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
  signal(pid: number): void {
    this.signals.push(pid);
    this.running = false;
    this.resolveExit();
  }
  now(): number {
    return this.clock;
  }
  pause(ms: number): Promise<void> {
    this.clock += ms;
    this.running = false;
    this.resolveExit();
    return Promise.resolve();
  }
  child() {
    return {
      pid: 42,
      exited: this.exited,
      alive: () => this.running,
      kill: () => {
        this.running = false;
        this.resolveExit();
      },
    };
  }
}

describe('benchmark child ownership', () => {
  test('rejects a missing initial root and never signals an unobserved group', async () => {
    const host = new FakeScopeHost();
    host.snapshots.push([], [root], []);
    const result = await new BenchmarkChildScope(host.child(), host).stop();
    expect(result.settled).toBe(false);
    expect(result.errors.join(' ')).toContain('expected initial native identity');
    expect(host.signals).toEqual([]);
  });

  test('retains census failure as an unconfirmed settlement', async () => {
    const host = new FakeScopeHost();
    host.snapshots.push(new Error('fixture census unavailable'), []);
    const result = await new BenchmarkChildScope(host.child(), host).stop();
    expect(result.settled).toBe(false);
    expect(result.errors.join(' ')).toContain('fixture census unavailable');
    expect(host.signals).toEqual([]);
  });

  test('does not signal a group anchored only by a reused pid', async () => {
    const host = new FakeScopeHost();
    host.snapshots.push([root], [{ ...root, identity: '42:2' }], []);
    const result = await new BenchmarkChildScope(host.child(), host).stop();
    expect(host.signals).toEqual([]);
    expect(result.settled).toBe(false);
    expect(result.errors.join(' ')).toContain('birth identity changed');
  });

  test('retains all cleanup causes alongside a primary failure', () => {
    const errors: string[] = [];
    let failure = 'readiness failed';
    failure = recordBenchmarkCleanup(errors, failure, 'Startup', 'census failed');
    failure = recordBenchmarkCleanup(errors, failure, 'Startup', 'stream did not settle');
    expect(failure).toBe('readiness failed');
    expect(errors).toEqual(['census failed', 'stream did not settle']);
    expect(recordBenchmarkCleanup([], null, 'Runtime', 'census failed')).toBe(
      'Runtime cleanup: census failed'
    );
  });

  test('reports a held stream and cancels its reader', async () => {
    class HeldStream {
      canceled = false;
      readonly stream = new ReadableStream<Uint8Array>({
        cancel: () => {
          this.canceled = true;
        },
      });
    }
    const held = new HeldStream();
    const output = pumpBenchmarkStream(held.stream);
    expect(await settleBenchmarkWork(output.done, 5)).toContain('did not settle');
    await output.cancel();
    await output.done;
    expect(held.canceled).toBe(true);
  });
});

class FakeReparentedChild {
  constructor(readonly home: string) {}
  start() {
    const script = `
      const [trigger, marker, release] = process.argv.slice(1);
      while (!(await Bun.file(trigger).exists())) await Bun.sleep(5);
      const program = 'const { rename } = await import("node:fs/promises"); const [marker, release] = process.argv.slice(1); await Bun.write(marker + ".tmp", String(process.pid)); await rename(marker + ".tmp", marker); while (!(await Bun.file(release).exists())) await Bun.sleep(5);';
      const leaf = Bun.spawn([process.execPath, '-e', program, marker, release], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      leaf.unref();
      while (!(await Bun.file(marker).exists())) await Bun.sleep(5);
    `;
    return Bun.spawn(
      [
        process.execPath,
        '-e',
        script,
        join(this.home, 'trigger'),
        join(this.home, 'leaf'),
        join(this.home, 'release'),
      ],
      {
        detached: true,
        env: fixtureChildEnvironment(),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      }
    );
  }
}

test.skipIf(process.platform === 'win32')(
  'retains an unproven scope after a real root exits before its reparented child is observed',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'benchmark-reparented-'));
    const child = new FakeReparentedChild(home).start();
    const scope = new BenchmarkChildScope({
      pid: child.pid,
      exited: child.exited,
      alive: () => child.exitCode === null && child.signalCode === null,
      kill: (signal) => child.kill(signal),
    });
    let leafIdentity: string | undefined;
    try {
      await scope.initialObservation();
      await Bun.write(join(home, 'trigger'), 'start descendant');
      const exitError = await settleBenchmarkWork(child.exited, 5_000);
      expect(exitError).toBeNull();
      const marker = await Bun.file(join(home, 'leaf')).text();
      const pid = Number(marker);
      expect({ marker, valid: /^[1-9][0-9]*$/.test(marker) && Number.isSafeInteger(pid) }).toEqual({
        marker,
        valid: true,
      });
      const leaf = (await snapshotNativeProcesses()).find((row) => row.pid === pid);
      leafIdentity = leaf?.identity;
      expect({ pid, observed: Boolean(leafIdentity) }).toEqual({ pid, observed: true });
      const result = await scope.stop();
      expect(result.settled).toBe(false);
      expect(result.errors.join(' ')).toContain('root exited without a verified group anchor');
    } finally {
      await Bun.write(join(home, 'trigger'), 'release fixture');
      await Bun.write(join(home, 'release'), 'release descendant');
      const rootError = await settleBenchmarkWork(child.exited, 5_000);
      const deadline = performance.now() + 5_000;
      while (
        leafIdentity &&
        performance.now() < deadline &&
        (await snapshotNativeProcesses()).some((row) => row.identity === leafIdentity)
      )
        await Bun.sleep(20);
      const alive =
        leafIdentity &&
        (await snapshotNativeProcesses()).some((row) => row.identity === leafIdentity);
      if (leafIdentity && !alive && !rootError) await rm(home, { recursive: true, force: true });
      expect(rootError).toBeNull();
      expect(alive).toBeFalsy();
    }
  },
  15_000
);

function settledResourceObservation(): ProcessResourceObservation {
  return {
    intervalMs: 10,
    clockOriginMs: 0,
    readinessAtMs: 1,
    measurementEndMs: 1,
    errors: [],
    frames: [],
    summary: {
      sampleCount: 1,
      observedProcessCount: 1,
      peakSampledRssBytes: 4096,
      sampledUserCpuMs: 0,
      sampledSystemCpuMs: 0,
      cpuResolutionMs: 10,
      remainingIdentities: [],
      frames: [],
    },
  };
}

describe('benchmark resource cleanup evidence', () => {
  test('requires available terminal evidence and retains census failure details', () => {
    expect(benchmarkResourceCleanupError(null)).toContain('received: unavailable');
    const observation = settledResourceObservation();
    expect(benchmarkResourceCleanupError({ ...observation, summary: null })).toContain(
      'terminal summary'
    );
    expect(
      benchmarkResourceCleanupError({ ...observation, errors: ['named terminal census failure'] })
    ).toContain('named terminal census failure');
  });

  test('refuses resource-owned remaining identities even when the native child scope is empty', () => {
    const observation = settledResourceObservation();
    if (!observation.summary)
      throw new Error('fixture summary: expected available | received: null');
    expect(
      benchmarkResourceCleanupError({
        ...observation,
        summary: { ...observation.summary, remainingIdentities: ['900001:100'] },
      })
    ).toContain('900001:100');
    expect(benchmarkResourceCleanupError(observation)).toBeNull();
  });

  test('keeps empty terminal evidence valid when no sample fell within the readiness window', () => {
    const observation = settledResourceObservation();
    if (!observation.summary)
      throw new Error('fixture summary: expected available | received: null');
    expect(
      benchmarkResourceCleanupError({
        ...observation,
        summary: {
          ...observation.summary,
          sampleCount: 0,
          peakSampledRssBytes: null,
          sampledUserCpuMs: null,
          sampledSystemCpuMs: null,
        },
      })
    ).toBeNull();
  });
});
