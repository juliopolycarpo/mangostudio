import { describe, expect, test } from 'bun:test';

import { SmokeHub } from '../lib/binary-smoke-hub';
import { FakeSmokeHub } from './support/fake-smoke-hub';

describe('owned artifact hub', () => {
  test('starts and settles both lifetimes, draining each stderr before restart', async () => {
    const fake = new FakeSmokeHub();
    const hub = new SmokeHub(fake.options());
    await hub.stop();
    await hub.start();
    await hub.captureRuntimeBaseline();
    fake.runtimeAlive = true;
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
      await hub.captureRuntimeBaseline();
      fake.runtimeAlive = true;
      await hub.observeRuntime();
      fake.runtimeParent = 1;
      await expect(hub.waitForRuntimeExit()).rejects.toThrow(
        'expected disconnected child processes to exit within 20ms'
      );
      // A reused PID belongs to a different identity and is not awaited or signalled.
      fake.runtimeIdentity = '900002:99';
      await hub.waitForRuntimeExit();
      fake.runtimeAlive = false;
      await expect(hub.observeRuntime()).rejects.toThrow('expected a new owned connection child');
    } finally {
      await hub.stop();
    }
  });
  test('cleans a leaked child after the leader exits and rejects forced cleanup', async () => {
    const fake = new FakeSmokeHub('leaked');
    const hub = new SmokeHub(fake.options());
    await hub.start();
    await hub.captureRuntimeBaseline();
    fake.runtimeAlive = true;
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
    await hub.captureRuntimeBaseline();
    fake.runtimeAlive = true;
    await hub.observeRuntime();
    fake.runtimeAlive = false;
    await hub.waitForRuntimeExit();
    await hub.stop();
    expect(fake.events).toEqual(['spawn', 'ready', 'SIGTERM']);
    expect(fake.signalled).toEqual([]);
  });
  test('Windows signalled exit settlement permits restart while exitCode remains null', async () => {
    const fake = new FakeSmokeHub();
    fake.nullExitCodeOnSignal = true;
    const hub = new SmokeHub({ ...fake.options(), platform: 'win32' });
    await hub.start();
    await hub.stop();
    expect(fake.root?.exitCode).toBeNull();
    expect(await fake.root?.exited).toBe(143);
    await hub.start();
    await hub.stop();
    expect(fake.events).toEqual(['spawn', 'ready', 'SIGTERM', 'spawn', 'ready', 'SIGTERM']);
  });
  test('non-Windows still rejects a signalled exit without a graceful zero status', async () => {
    const fake = new FakeSmokeHub();
    fake.nullExitCodeOnSignal = true;
    const hub = new SmokeHub(fake.options());
    await hub.start();
    await expect(hub.stop()).rejects.toThrow('expected graceful exit 0 | received null');
  });
  test('a failed stderr drain retains the signalled child until cleanup can be retried', async () => {
    const fake = new FakeSmokeHub();
    fake.nullExitCodeOnSignal = true;
    fake.holdStderr = true;
    const hub = new SmokeHub({ ...fake.options(), platform: 'win32' });
    await hub.start();
    await expect(hub.stop()).rejects.toThrow(
      'process stderr drain: expected settlement within 20ms'
    );
    await expect(hub.start()).rejects.toThrow('expected previous child settled');
    fake.closeStderr();
    await hub.stop();
    await hub.start();
    await hub.stop();
    expect(fake.events.filter((event) => event === 'spawn')).toHaveLength(2);
  });
  test('an unverified terminal census retains ownership for a later cleanup attempt', async () => {
    const fake = new FakeSmokeHub();
    fake.nullExitCodeOnSignal = true;
    const hub = new SmokeHub({ ...fake.options(), platform: 'win32' });
    await hub.start();
    fake.snapshotFailure = true;
    await expect(hub.stop()).rejects.toThrow('incomplete fake process census');
    expect(fake.supervisorHost.handlersInstalled).toBe(4);
    await expect(hub.start()).rejects.toThrow('expected previous child settled');
    fake.snapshotFailure = false;
    await hub.stop();
    expect(fake.supervisorHost.handlersInstalled).toBe(0);
    await hub.start();
    await hub.stop();
    expect(fake.events.filter((event) => event === 'spawn')).toHaveLength(2);
  });
  test.each(['cancel', 'exit'] as const)(
    'held stderr cannot keep a stale POSIX signal lease after empty census (%s)',
    async (event) => {
      const fake = new FakeSmokeHub();
      fake.holdStderr = true;
      const hub = new SmokeHub(fake.options());
      await hub.start();
      try {
        await expect(hub.stop()).rejects.toThrow(
          'process stderr drain: expected settlement within 20ms'
        );
        await expect(hub.start()).rejects.toThrow('expected previous child settled');
        fake.reusedGroup = true;
        fake.supervisorHost.liveGroups.add(900001);
        if (event === 'cancel') fake.supervisorHost.deliver('SIGTERM');
        else fake.supervisorHost.endProcess();
        await Bun.sleep(0);
        expect(fake.supervisorHost.groupKills).toEqual([]);
        expect(fake.signalled).toEqual([-900001]);
      } finally {
        fake.closeStderr();
        await hub.stop();
      }
    }
  );
  test('disconnect waits only for the new user runtime and console, retaining warm-up ownership until shutdown', async () => {
    const fake = new FakeSmokeHub();
    fake.warmupAlive = true;
    fake.warmupConsoleAlive = true;
    const hub = new SmokeHub({ ...fake.options(), platform: 'win32' });
    await hub.start();
    try {
      await hub.captureRuntimeBaseline();
      fake.runtimeAlive = true;
      fake.runtimeConsoleAlive = true;
      await hub.observeRuntime();
      fake.runtimeAlive = false;
      fake.runtimeConsoleAlive = false;
      await hub.waitForRuntimeExit();
      expect(fake.warmupAlive).toBe(true);
      expect(fake.warmupConsoleAlive).toBe(true);
    } finally {
      await hub.stop();
    }
    expect(fake.warmupAlive).toBe(false);
    expect(fake.warmupConsoleAlive).toBe(false);
    expect(fake.signalled).toEqual([]);
  });
  test('a baseline warm-up runtime and its later console cannot stand in for a new user connection', async () => {
    const fake = new FakeSmokeHub();
    fake.warmupAlive = true;
    const hub = new SmokeHub(fake.options());
    await hub.start();
    try {
      await hub.captureRuntimeBaseline();
      fake.warmupConsoleAlive = true;
      await expect(hub.observeRuntime()).rejects.toThrow('expected a new owned connection child');
      await expect(hub.waitForRuntimeExit()).rejects.toThrow(
        'expected an observed connection cohort'
      );
    } finally {
      await hub.stop();
    }
  });
  test('final shutdown retains and settles a leaked baseline warm-up pair', async () => {
    const fake = new FakeSmokeHub('leaked');
    fake.warmupAlive = true;
    fake.warmupConsoleAlive = true;
    const hub = new SmokeHub({ ...fake.options(), platform: 'win32' });
    await hub.start();
    await hub.captureRuntimeBaseline();
    fake.runtimeAlive = true;
    await hub.observeRuntime();
    fake.runtimeAlive = false;
    await hub.waitForRuntimeExit();
    await expect(hub.stop()).rejects.toThrow('received SIGKILL, settled=true');
    expect(fake.signalled).toEqual([900010, 900011]);
    expect(fake.warmupAlive).toBe(false);
    expect(fake.warmupConsoleAlive).toBe(false);
    await hub.stop();
  });
  test('an observed user console surviving its runtime is named in the failed exit wait', async () => {
    const fake = new FakeSmokeHub();
    fake.warmupAlive = true;
    const hub = new SmokeHub(fake.options());
    await hub.start();
    try {
      await hub.captureRuntimeBaseline();
      fake.runtimeAlive = true;
      fake.runtimeConsoleAlive = true;
      await hub.observeRuntime();
      fake.runtimeAlive = false;
      await expect(hub.waitForRuntimeExit()).rejects.toThrow(
        '"identity":"900004:21","command":"runtime conhost"'
      );
      fake.runtimeConsoleAlive = false;
      await hub.waitForRuntimeExit();
    } finally {
      await hub.stop();
    }
  });
  test('restart clears the previous connection baseline and observed cohort', async () => {
    const fake = new FakeSmokeHub();
    const hub = new SmokeHub(fake.options());
    await expect(hub.captureRuntimeBaseline()).rejects.toThrow('expected a running hub');
    await hub.start();
    await expect(hub.observeRuntime()).rejects.toThrow('expected connection baseline');
    await hub.captureRuntimeBaseline();
    fake.runtimeAlive = true;
    await hub.observeRuntime();
    await hub.stop();
    await hub.start();
    try {
      await expect(hub.waitForRuntimeExit()).rejects.toThrow(
        'expected an observed connection cohort'
      );
      await expect(hub.observeRuntime()).rejects.toThrow('expected connection baseline');
      await hub.captureRuntimeBaseline();
      fake.runtimeAlive = true;
      await hub.observeRuntime();
      fake.runtimeAlive = false;
      await hub.waitForRuntimeExit();
    } finally {
      await hub.stop();
    }
  });
});
