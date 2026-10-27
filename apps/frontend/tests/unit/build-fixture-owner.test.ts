import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuildFixtureDiagnostics } from '../support/build-fixture-diagnostics';
import { BuildFixtureOwner } from '../support/build-fixture-owner';

class FakeFinishRegistrar {
  cleanup?: () => Promise<void>;
  register = (cleanup: () => Promise<void>) => {
    this.cleanup = cleanup;
  };
}

class HeldPreparation {
  release!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  run = () => this.done;
}

class HeldBuildProcess {
  readonly pid = 9182;
  readonly signalCode = null;
  resolveExit!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });
  errorOutput!: ReadableStreamDefaultController<Uint8Array>;
  readonly stdout = new ReadableStream<Uint8Array>();
  readonly stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.errorOutput = controller;
    },
  });
  stopCalled!: () => void;
  readonly stopped = new Promise<void>((resolve) => {
    this.stopCalled = resolve;
  });
  kill() {
    this.stopCalled();
  }
}

describe('build fixture ownership', () => {
  test('waits for held setup before removal and refuses its late continuation', async () => {
    const path = await mkdtemp(join(tmpdir(), 'mango-owner-held-'));
    const finish = new FakeFinishRegistrar();
    const owner = new BuildFixtureOwner(new BuildFixtureDiagnostics('held', () => {}), {
      register: finish.register,
    });
    const held = new HeldPreparation();
    owner.own(path);
    const setup = owner.prepare(held.run).catch((error: unknown) => error);
    const cleanup = finish.cleanup?.();
    if (!cleanup) throw new Error('expected a registered fixture cleanup');
    expect(existsSync(path)).toBe(true);
    held.release();
    await cleanup;
    expect(existsSync(path)).toBe(false);
    expect(String(await setup)).toContain('fixture closed during preparation');
    expect(owner.close()).toBe(cleanup);
  });

  test('retains the fixture when setup does not settle by the cleanup deadline', async () => {
    const path = await mkdtemp(join(tmpdir(), 'mango-owner-timeout-'));
    const finish = new FakeFinishRegistrar();
    const owner = new BuildFixtureOwner(new BuildFixtureDiagnostics('held', () => {}), {
      register: finish.register,
      timeoutMs: 25,
    });
    const held = new HeldPreparation();
    owner.own(path);
    const setup = owner.prepare(held.run).catch((error: unknown) => error);
    try {
      await expect(owner.close()).rejects.toThrow('retaining');
      expect(existsSync(path)).toBe(true);
    } finally {
      held.release();
      await setup;
      await rm(path, { recursive: true, force: true });
    }
  });

  test('waits for the retained child after a drain fails before removing the fixture', async () => {
    const path = await mkdtemp(join(tmpdir(), 'mango-owner-child-'));
    const finish = new FakeFinishRegistrar();
    const diagnostics = new BuildFixtureDiagnostics('held child', () => {});
    const owner = new BuildFixtureOwner(diagnostics, { register: finish.register });
    const child = new HeldBuildProcess();
    const failure = new Error('named drain failure');
    owner.own(path);
    const operation = owner
      .run(async () => {
        await diagnostics.observe(child);
      })
      .catch((error: unknown) => error);
    child.errorOutput.error(failure);
    try {
      await child.stopped;
      expect(existsSync(path)).toBe(true);
      child.resolveExit(143);
      expect(await operation).toBe(failure);
      expect(child.stdout.locked).toBe(false);
      expect(child.stderr.locked).toBe(false);
      expect(existsSync(path)).toBe(false);
    } finally {
      child.resolveExit(143);
      await rm(path, { recursive: true, force: true });
    }
  });

  test('retains the fixture when a stopped child cannot be confirmed exited', async () => {
    const path = await mkdtemp(join(tmpdir(), 'mango-owner-child-timeout-'));
    const finish = new FakeFinishRegistrar();
    const diagnostics = new BuildFixtureDiagnostics('held child', () => {});
    const owner = new BuildFixtureOwner(diagnostics, { register: finish.register, timeoutMs: 25 });
    const child = new HeldBuildProcess();
    owner.own(path);
    const observation = diagnostics.observe(child).catch((error: unknown) => error);
    try {
      await expect(owner.close()).rejects.toThrow('retaining');
      await child.stopped;
      expect(existsSync(path)).toBe(true);
    } finally {
      child.resolveExit(143);
      await observation;
      await rm(path, { recursive: true, force: true });
    }
  });

  test('bounds a held removal after the child and setup have settled', async () => {
    const path = await mkdtemp(join(tmpdir(), 'mango-owner-removal-timeout-'));
    const finish = new FakeFinishRegistrar();
    const heldRemoval = new HeldPreparation();
    const owner = new BuildFixtureOwner(new BuildFixtureDiagnostics('held removal', () => {}), {
      register: finish.register,
      timeoutMs: 25,
      remove: heldRemoval.run,
    });
    owner.own(path);
    try {
      await expect(owner.close()).rejects.toThrow('fixture removal did not settle');
      expect(existsSync(path)).toBe(true);
    } finally {
      heldRemoval.release();
      await heldRemoval.done;
      await rm(path, { recursive: true, force: true });
    }
  });

  test('reports the original body error and removal failure together', async () => {
    const path = await mkdtemp(join(tmpdir(), 'mango-owner-failure-'));
    const finish = new FakeFinishRegistrar();
    const primary = new Error('named preparation failure');
    const removal = new Error('named removal failure');
    const refusingRemoval = () => Promise.reject(removal);
    const owner = new BuildFixtureOwner(new BuildFixtureDiagnostics('errors', () => {}), {
      register: finish.register,
      remove: refusingRemoval,
    });
    owner.own(path);
    try {
      const result = await owner
        .run(() => Promise.reject(primary))
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([primary, removal]);
      expect(existsSync(path)).toBe(true);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});
