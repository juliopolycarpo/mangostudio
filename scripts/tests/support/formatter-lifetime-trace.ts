import { appendFileSync } from 'node:fs';

export const FORMATTER_LIFETIME_TRACE = import.meta.path;

const tracePath =
  process.env.MANGO_TEST_FORMATTER_TRACE_CHILD === '1'
    ? process.env.MANGO_TEST_FORMATTER_TRACE
    : undefined;
if (tracePath) {
  const record = (event: string, fields: Record<string, unknown> = {}) => {
    appendFileSync(
      tracePath,
      `${JSON.stringify({ event, at: performance.timeOrigin + performance.now(), ...fields })}\n`
    );
  };

  let formatterPid: number | undefined;
  const nativeSpawn = Bun.spawn;
  Bun.spawn = ((...args: unknown[]) => {
    const command = Array.isArray(args[0]) ? args[0] : undefined;
    if (command?.[0] !== 'rustfmt') return Reflect.apply(nativeSpawn, Bun, args);
    record('formatter-spawn');
    const child = Reflect.apply(nativeSpawn, Bun, args) as ReturnType<typeof Bun.spawn>;
    formatterPid = child.pid;
    record('formatter-spawn-returned', { pid: child.pid });
    const nativeKill = child.kill.bind(child);
    child.kill = (signal) => {
      record('formatter-handle-kill', { pid: child.pid, signal });
      nativeKill(signal);
    };
    void child.exited.then((exitCode) =>
      record('formatter-exit', { exitCode, signal: child.signalCode })
    );
    return child;
  }) as typeof Bun.spawn;

  const nativeSchedule = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: unknown[]) => {
    const [callback, delay, ...forwarded] = args;
    if (formatterPid === undefined || delay !== 5000 || typeof callback !== 'function') {
      return Reflect.apply(nativeSchedule, globalThis, args);
    }
    record('formatter-deadline-armed', { delay, pid: formatterPid });
    return Reflect.apply(nativeSchedule, globalThis, [
      (...timerArgs: unknown[]) => {
        record('formatter-deadline-fired', { pid: formatterPid });
        Reflect.apply(callback, undefined, timerArgs);
      },
      delay,
      ...forwarded,
    ]);
  }) as typeof setTimeout;

  const nativeSpawnSync = Bun.spawnSync;
  Bun.spawnSync = ((...args: unknown[]) => {
    const command = Array.isArray(args[0]) ? args[0] : undefined;
    if (command?.[0] !== 'taskkill' || command.at(-1) !== String(formatterPid)) {
      return Reflect.apply(nativeSpawnSync, Bun, args);
    }
    record('taskkill-start', { pid: formatterPid });
    const result = Reflect.apply(nativeSpawnSync, Bun, args) as ReturnType<typeof Bun.spawnSync>;
    record('taskkill-return', { exitCode: result.exitCode, signal: result.signalCode });
    return result;
  }) as typeof Bun.spawnSync;

  process.on('exit', (exitCode) => record('hook-exit', { exitCode }));
}
