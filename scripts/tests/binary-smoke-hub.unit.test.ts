import { describe, expect, test } from 'bun:test';

import { SmokeHub } from '../lib/binary-smoke-hub';
import { FakeSmokeHub } from './support/fake-smoke-hub';

describe('owned artifact hub', () => {
  test('starts and settles both lifetimes, draining each stderr before restart', async () => {
    const fake = new FakeSmokeHub();
    const hub = new SmokeHub(fake.options());
    await hub.stop();
    await hub.start();
    await hub.observeRuntime();
    await expect(hub.start()).rejects.toThrow('expected previous child settled');
    await hub.stop();
    expect(hub.errorText()).toBe('fake stderr');
    await hub.start();
    await hub.stop();
    expect(fake.events).toEqual(['spawn', 'ready', 'SIGTERM', 'spawn', 'ready', 'SIGTERM']);
    expect(fake.signalled).toEqual([-900001, -900001]);
  });
  test('failed readiness leaves the exact child owned for finally cleanup', async () => {
    const fake = new FakeSmokeHub();
    fake.readyFailure = true;
    const hub = new SmokeHub(fake.options());
    await expect(hub.start()).rejects.toThrow('readiness failed');
    await hub.stop();
    expect(fake.root?.exitCode).toBe(0);
    expect(hub.errorText()).toBe('fake stderr');
  });
  test('requires a runtime descendant and waits its observed identity after reparenting', async () => {
    const fake = new FakeSmokeHub();
    const hub = new SmokeHub(fake.options());
    await hub.start();
    try {
      await hub.observeRuntime();
      fake.runtimeParent = 1;
      await expect(hub.waitForRuntimeExit()).rejects.toThrow(
        'expected disconnected child processes to exit within 20ms'
      );
      // A reused PID belongs to a different identity and is not awaited or signalled.
      fake.runtimeIdentity = '900002:99';
      await hub.waitForRuntimeExit();
      fake.runtimeAlive = false;
      await expect(hub.observeRuntime()).rejects.toThrow('expected an owned runtime child');
    } finally {
      await hub.stop();
    }
  });
  test('cleans a leaked child after the leader exits and rejects forced cleanup', async () => {
    const fake = new FakeSmokeHub('leaked');
    const hub = new SmokeHub(fake.options());
    await hub.start();
    await hub.observeRuntime();
    await expect(hub.stop()).rejects.toThrow('received SIGKILL, settled=true');
    expect(fake.events).toEqual(['spawn', 'ready', 'SIGTERM', 'SIGKILL']);
    expect(fake.signalled).not.toContain(900003);
    await hub.stop();
  });
  test('an exited root cannot authorize signalling a reused process group', async () => {
    const fake = new FakeSmokeHub();
    const hub = new SmokeHub(fake.options());
    await hub.start();
    fake.root?.kill('SIGTERM');
    fake.runtimeAlive = false;
    fake.reusedGroup = true;
    await hub.stop();
    expect(fake.signalled).toEqual([]);
  });
  test('Windows stops its exact hub handle after the runtime was disconnected', async () => {
    const fake = new FakeSmokeHub();
    const hub = new SmokeHub({ ...fake.options(), platform: 'win32' });
    await hub.start();
    await hub.observeRuntime();
    fake.runtimeAlive = false;
    await hub.waitForRuntimeExit();
    await hub.stop();
    expect(fake.events).toEqual(['spawn', 'ready', 'SIGTERM']);
    expect(fake.signalled).toEqual([]);
  });
});
