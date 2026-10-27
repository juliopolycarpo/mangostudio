import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  probeRuntimeBinary,
  type RuntimeVersionProcess,
} from '../../../src/cli/runtime-binary-probe';

let workdir = '';

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-runtime-probe-'));
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
});

describe('probeRuntimeBinary', () => {
  it('reports a source checkout as nothing to check', async () => {
    expect(await probeRuntimeBinary(null)).toEqual({
      path: null,
      present: false,
      version: null,
      error: null,
    });
  });

  it('reports a missing sibling as absent rather than broken', async () => {
    const path = join(workdir, 'no-such-runtime');

    expect(await probeRuntimeBinary(path)).toEqual({
      path,
      present: false,
      version: null,
      error: null,
    });
  });

  // Doctor's whole job is to describe a broken install, so a path that exists
  // but cannot be executed has to come back as a finding. Spawning it throws
  // rather than resolving, which would otherwise take the whole command down.
  it('reports a path that exists but cannot be run', async () => {
    const path = join(workdir, 'runtime-is-a-directory');
    await mkdir(path, { recursive: true });

    const probe = await probeRuntimeBinary(path);

    expect(probe.path).toBe(path);
    expect(probe.present).toBe(true);
    expect(probe.version).toBeNull();
    expect(probe.error).toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')(
    'reports a runtime that answers with a version',
    async () => {
      const path = join(workdir, 'fake-runtime');
      await writeFile(path, '#!/bin/sh\necho 1.2.3-test\n');
      await chmod(path, 0o755);

      expect(await probeRuntimeBinary(path)).toEqual({
        path,
        present: true,
        version: '1.2.3-test',
        error: null,
      });
    }
  );

  it.skipIf(process.platform === 'win32')('reports a runtime that exits non-zero', async () => {
    const path = join(workdir, 'failing-runtime');
    await writeFile(path, '#!/bin/sh\nexit 3\n');
    await chmod(path, 0o755);

    const probe = await probeRuntimeBinary(path);

    expect(probe.present).toBe(true);
    expect(probe.version).toBeNull();
    expect(probe.error).toBe('exited with code 3');
  });
});

class FakeRuntimeVersion implements RuntimeVersionProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly signals: Array<'SIGKILL' | undefined> = [];
  cancelled = false;
  killError: Error | undefined;
  private output!: ReadableStreamDefaultController<Uint8Array>;
  private finish!: (code: number) => void;

  constructor(private readonly exitOnKill = true) {
    this.stdout = new ReadableStream({
      start: (controller) => {
        this.output = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  spawn = (): RuntimeVersionProcess => this;
  write(bytes: Uint8Array): void {
    this.output.enqueue(bytes);
  }
  closeOutput(): void {
    if (!this.cancelled) this.output.close();
  }
  failOutput(error: Error): void {
    this.output.error(error);
  }
  exit(code: number): void {
    this.finish(code);
  }
  kill(signal?: 'SIGKILL'): void {
    this.signals.push(signal);
    if (this.killError) throw this.killError;
    if (this.exitOnKill) this.exit(137);
  }
}

afterEach(() => {
  jest.useRealTimers();
});

it('rejects a retained stdout pipe at the deadline even after a successful root exit', async () => {
  jest.useFakeTimers();
  const child = new FakeRuntimeVersion();
  let settled = false;
  const result = probeRuntimeBinary(process.execPath, child.spawn).then((probe) => {
    settled = true;
    return probe;
  });
  child.write(new TextEncoder().encode('1.2.3'));
  child.exit(0);
  try {
    jest.advanceTimersByTime(5_000);
    jest.useRealTimers();
    await Bun.sleep(0);
    expect(settled).toBe(true);
    expect(child.cancelled).toBe(true);
    expect((await result).error).toBe('runtime --version timed out after 5000 ms');
    expect(child.signals).toEqual(['SIGKILL']);
  } finally {
    child.closeOutput();
    child.exit(137);
    await result;
  }
});

it('keeps ownership after a read failure until the runtime exits', async () => {
  const child = new FakeRuntimeVersion(false);
  let settled = false;
  const result = probeRuntimeBinary(process.execPath, child.spawn).then((probe) => {
    settled = true;
    return probe;
  });
  child.failOutput(new Error('stdout: expected readable pipe | received: broken pipe'));
  try {
    await Bun.sleep(0);
    expect(child.signals).toEqual(['SIGKILL']);
    expect(settled).toBe(false);
    child.exit(137);
    expect((await result).error).toBe('stdout: expected readable pipe | received: broken pipe');
    expect(child.stdout.locked).toBe(false);
  } finally {
    child.exit(137);
    await result;
  }
});

it('waits for the actual runtime exit after timeout cancellation', async () => {
  jest.useFakeTimers();
  const child = new FakeRuntimeVersion(false);
  let settled = false;
  const result = probeRuntimeBinary(process.execPath, child.spawn).then((probe) => {
    settled = true;
    return probe;
  });
  try {
    jest.advanceTimersByTime(4_999);
    expect(child.signals).toEqual([]);
    jest.advanceTimersByTime(1);
    jest.useRealTimers();
    await Bun.sleep(0);
    expect(child.cancelled).toBe(true);
    expect(settled).toBe(false);
    child.exit(137);
    expect((await result).error).toBe('runtime --version timed out after 5000 ms');
  } finally {
    child.exit(137);
    await result;
  }
});

it('decodes split UTF-8 and clears the deadline after success', async () => {
  jest.useFakeTimers();
  const child = new FakeRuntimeVersion();
  const result = probeRuntimeBinary(process.execPath, child.spawn);
  const bytes = new TextEncoder().encode('1.2.3-é');
  child.write(bytes.slice(0, -1));
  child.write(bytes.slice(-1));
  child.closeOutput();
  child.exit(0);
  expect((await result).version).toBe('1.2.3-é');
  jest.advanceTimersByTime(5_000);
  expect(child.signals).toEqual([]);
  expect(child.stdout.locked).toBe(false);
});

it('reports empty successful runtime output', async () => {
  const child = new FakeRuntimeVersion();
  const result = probeRuntimeBinary(process.execPath, child.spawn);
  child.closeOutput();
  child.exit(0);
  expect((await result).error).toBe('printed no version');
});

it('cancels output and awaits exit when a deadline kill throws', async () => {
  jest.useFakeTimers();
  const child = new FakeRuntimeVersion(false);
  child.killError = new Error('stop runtime: expected kill permission | received: EPERM');
  let settled = false;
  const result = probeRuntimeBinary(process.execPath, child.spawn).then((probe) => {
    settled = true;
    return probe;
  });
  try {
    expect(() => jest.advanceTimersByTime(5_000)).not.toThrow();
    jest.useRealTimers();
    await Bun.sleep(0);
    expect(child.cancelled).toBe(true);
    expect(settled).toBe(false);
    child.exit(137);
    const probe = await result;
    expect(probe.error).toContain('runtime --version timed out after 5000 ms');
    expect(probe.error).toContain('stop runtime: expected kill permission | received: EPERM');
  } finally {
    child.closeOutput();
    child.exit(137);
    await result;
  }
});

it('preserves a read failure and stop failure while awaiting runtime exit', async () => {
  const child = new FakeRuntimeVersion(false);
  child.killError = new Error('stop runtime: expected kill permission | received: EPERM');
  let settled = false;
  const result = probeRuntimeBinary(process.execPath, child.spawn).then((probe) => {
    settled = true;
    return probe;
  });
  child.failOutput(new Error('stdout: expected readable pipe | received: broken pipe'));
  try {
    await Bun.sleep(0);
    expect(settled).toBe(false);
    child.exit(137);
    const probe = await result;
    expect(probe.error).toContain('stdout: expected readable pipe | received: broken pipe');
    expect(probe.error).toContain('stop runtime: expected kill permission | received: EPERM');
  } finally {
    child.exit(137);
    await result;
  }
});
