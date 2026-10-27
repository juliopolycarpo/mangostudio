/** Named preload interposer; only controlled child hooks enable it through CONTROL_ENV. */
import { existsSync } from 'node:fs';

import { publishFixtureJson } from './atomic-fixture-json';
import { CONTROL_ENV, formatterControlPath, MARKER_ENV } from './fake-rustfmt-markers';

export const FORMATTER_CANCEL_CONTROL = import.meta.path;

function installFormatterControl(mode: string, marker: string): void {
  const nativeSpawn = Bun.spawn;
  const nativeKill = process.kill;
  const nativeSchedule = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let capturedDeadline: (() => void) | undefined;
  let groupStops = 0;
  let handleStops = 0;
  let nativeSettled = false;
  let childPid: number | undefined;
  const listeners = () =>
    Object.fromEntries(
      ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, process.listenerCount(signal)])
    );
  const publish = (event: string, value: Record<string, unknown>) =>
    publishFixtureJson(formatterControlPath(marker, event), value);

  const waitRelease = async (event: string): Promise<void> => {
    const deadline = performance.now() + 5000;
    while (!existsSync(formatterControlPath(marker, event))) {
      if (performance.now() >= deadline)
        throw new Error(`formatter ${event}: expected controlled release within 5000ms`);
      await Bun.sleep(5);
    }
  };

  globalThis.setTimeout = ((...args: unknown[]) => {
    if (args[1] !== 5000 || typeof args[0] !== 'function')
      return Reflect.apply(nativeSchedule, globalThis, args);
    const callback = args[0];
    const invoke = () => {
      timers.delete(timer);
      Reflect.apply(callback, undefined, args.slice(2));
    };
    const timer = nativeSchedule(invoke, 5000);
    capturedDeadline = invoke;
    timers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer);
    nativeClear(timer);
  }) as typeof clearTimeout;

  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (childPid === undefined || pid !== -childPid || signal !== 'SIGKILL') {
      throw new Error(
        `expected the owned formatter group SIGKILL | received ${pid} ${String(signal)}`
      );
    }
    groupStops++;
    // A deliberately broken lifecycle may request another stop after reap. Record
    // it for the assertion without ever signaling a potentially reused group.
    if (groupStops > 1 || nativeSettled) return true;
    return Reflect.apply(nativeKill, process, [pid, signal]);
  }) as typeof process.kill;

  process.on('exit', () =>
    publish('control-exit', {
      listeners: listeners(),
      timers: timers.size,
      groupStops,
      handleStops,
      nativeSettled,
      childPid,
    })
  );

  Bun.spawn = ((...args: unknown[]) => {
    const command = Array.isArray(args[0]) ? args[0] : undefined;
    if (command?.[0] !== 'rustfmt') return Reflect.apply(nativeSpawn, Bun, args);
    if (mode === 'spawn-throw') {
      queueMicrotask(() =>
        publish('spawn-throw-observed', { listeners: listeners(), timers: timers.size })
      );
      throw new Error('controlled formatter spawn refusal');
    }
    const formatter = Reflect.apply(nativeSpawn, Bun, args) as ReturnType<typeof Bun.spawn>;
    childPid = formatter.pid;
    publish('spawn-gate', { listeners: listeners(), childPid });
    if (mode === 'spawn-gap') {
      const deadline = performance.now() + 5000;
      while (!existsSync(formatterControlPath(marker, 'spawn-release'))) {
        if (performance.now() >= deadline)
          throw new Error('expected formatter spawn release within 5000ms');
        Bun.sleepSync(1);
      }
    }

    const exit = formatter.exited.then(async (code) => {
      nativeSettled = true;
      if (mode === 'exit-settlement') capturedDeadline?.();
      if (mode === 'deadline-first') process.emit('SIGINT', 'SIGINT');
      if (mode === 'exit-settlement' || mode === 'deadline-first') {
        process.emit('SIGTERM', 'SIGTERM');
        process.emit('SIGHUP', 'SIGHUP');
        process.emit('SIGINT', 'SIGINT');
        publish('exit-observed', {
          code,
          listeners: listeners(),
          groupStops,
          handleStops,
          timers: timers.size,
        });
        await waitRelease('exit-release');
      }
      publish('native-exited', { code, groupStops, handleStops });
      return code;
    });

    if (mode === 'deadline-first') {
      const poll = setInterval(() => {
        if (!existsSync(formatterControlPath(marker, 'fire-deadline')) || !capturedDeadline) return;
        clearInterval(poll);
        capturedDeadline();
      }, 5);
      void formatter.exited.then(() => clearInterval(poll));
    }
    if (mode === 'signal-before-return') {
      process.emit('SIGINT', 'SIGINT');
      process.emit('SIGTERM', 'SIGTERM');
    }
    return {
      pid: formatter.pid,
      exited: exit,
      kill(signal: NodeJS.Signals) {
        handleStops++;
        if (!nativeSettled) formatter.kill(signal);
      },
    };
  }) as typeof Bun.spawn;
}

const mode = process.env[CONTROL_ENV];
if (mode) {
  const marker = process.env[MARKER_ENV];
  if (!marker) throw new Error(`${MARKER_ENV}: expected controlled formatter marker`);
  installFormatterControl(mode, marker);
}
