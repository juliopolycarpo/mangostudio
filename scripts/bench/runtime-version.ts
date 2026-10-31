import { rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';

import {
  type NativeCommandReceipt,
  runNativeCommand,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';
import { homeEnv } from '../lib/temp-home';
import { assertBenchmarkPlatform } from './benchmark-platform';

const ROOT = resolve(import.meta.dir, '../..');

type Runner = typeof runNativeCommand;

/** Failure receipt for an untimed version probe; its home remains available for inspection. */
export class RuntimeVersionError extends Error {
  readonly safeToRemove = false;
  constructor(
    message: string,
    readonly home: string,
    readonly commandReceipt: NativeCommandReceipt | null,
    readonly settlement: 'confirmed' | 'unconfirmed',
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'RuntimeVersionError';
  }
}

/** Identify a runtime outside measured samples, retaining its isolated home on failure.
 * @example await runtimeVersion('/path/to/runtime', cancellation.signal);
 */
export async function runtimeVersion(
  binary: string,
  signal: AbortSignal,
  options: {
    readonly run?: Runner;
    readonly cleanupMs?: number;
    readonly timeoutMs?: number;
    readonly platform?: NodeJS.Platform;
    readonly readVersion?: (path: string) => Promise<string>;
  } = {}
): Promise<string> {
  assertBenchmarkPlatform(options.platform ?? process.platform);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cleanupMs = options.cleanupMs ?? 5_000;
  for (const [name, value] of [
    ['timeoutMs', timeoutMs],
    ['cleanupMs', cleanupMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name}: expected positive finite milliseconds | received: ${value}`);
  }
  const home = await mkdtemp(join(tmpdir(), 'mango-handshake-version-'));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let cancellationReason: Error | undefined;
  let running = false;
  let expire!: () => void;
  const expired = new Promise<null>((done) => {
    expire = () => done(null);
  });
  const cancel = () => {
    cancellationReason =
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Runtime version canceled', { cause: signal.reason });
    if (!running) {
      controller.abort(cancellationReason);
      return;
    }
    if (escalation) clearTimeout(escalation);
    void Bun.write(join(home, 'version-cancel'), 'cancel').catch(() => {});
    escalation = setTimeout(() => controller.abort(cancellationReason), Math.min(500, cleanupMs));
    if (timer) clearTimeout(timer);
    timer = setTimeout(expire, cleanupMs);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  else
    timer = setTimeout(() => {
      cancellationReason = new Error('Runtime version deadline expired');
      void Bun.write(join(home, 'version-cancel'), 'cancel').catch(() => {});
      escalation = setTimeout(() => controller.abort(cancellationReason), Math.min(500, cleanupMs));
      timer = setTimeout(expire, cleanupMs);
    }, timeoutMs);
  const assertActive = () => {
    if (cancellationReason !== undefined) throw cancellationReason;
    if (controller.signal.aborted)
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('Runtime version canceled', { cause: controller.signal.reason });
  };
  let receipt: NativeCommandReceipt | null = null;
  let wrapperIdentity: string | undefined;
  let started = false;
  let finished = false;
  let descendantRefused = false;
  const snapshot = async () => {
    const rows = await snapshotNativeProcesses();
    const pidText = await readFile(join(home, 'version-wrapper-pid'), 'utf8').catch(() => '');
    const pid = Number(pidText);
    const wrapper = rows.find(
      (row) =>
        row.pid === pid &&
        row.parentPid === process.pid &&
        (process.platform === 'win32' || row.group === pid)
    );
    if (wrapper && (!wrapperIdentity || wrapper.identity === wrapperIdentity)) {
      wrapperIdentity = wrapper.identity;
      if (!started) {
        await Bun.write(join(home, 'version-start'), 'go');
        started = true;
      } else if (!finished && (await Bun.file(join(home, 'version-done')).exists())) {
        const done: unknown = JSON.parse(await readFile(join(home, 'version-done'), 'utf8'));
        if (
          typeof done !== 'object' ||
          done === null ||
          !('pid' in done) ||
          !Number.isSafeInteger(done.pid) ||
          typeof done.pid !== 'number' ||
          done.pid <= 0
        )
          throw new Error('version-done: expected direct child PID');
        // The wrapper has already awaited this exact child. Wait for its census entry to disappear.
        if (rows.some((row) => row.pid === done.pid)) return rows;
        const descendants = rows.filter((row) => row.pid !== pid && row.group === pid);
        if (process.platform !== 'win32' && descendants.length > 0) {
          if (!descendantRefused) {
            descendantRefused = true;
            controller.abort(
              new Error(
                `runtime version expected no surviving same-group descendants | received: ${descendants.length}`
              )
            );
          }
        } else {
          await Bun.write(join(home, 'version-finish'), 'go');
          finished = true;
        }
      }
    }
    return rows;
  };
  try {
    assertActive();
    running = true;
    const pending = (options.run ?? runNativeCommand)({
      label: 'runtime-version',
      command: [process.execPath, join(import.meta.dir, 'runtime-version-child.ts'), binary, home],
      root: ROOT,
      out: home,
      env: { ...process.env, ...homeEnv(home), MANGO_HOME: home },
      timeoutSeconds: timeoutMs / 1_000,
      pollIntervalMs: 20,
      settleMs: 1_000,
      guardCompilerHelpers: false,
      snapshot,
      stream: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      signal: controller.signal,
    });
    receipt = await Promise.race([pending, expired]);
    if (!receipt) throw new Error('cleanup deadline expired before supervisor settled');
    const clean =
      !controller.signal.aborted &&
      !signal.aborted &&
      cancellationReason === undefined &&
      receipt.exitCode === 0 &&
      receipt.signal === null &&
      !receipt.timedOut &&
      !receipt.canceled &&
      receipt.errors.length === 0 &&
      receipt.settlement.empty &&
      receipt.settlement.rootObserved &&
      receipt.settlement.snapshotErrors.length === 0 &&
      (receipt.settlement.pollErrors?.length ?? 0) === 0;
    assertActive();
    if (!clean)
      throw new Error(
        `expected successful exit, closed pipes and an error-free empty scope | received: ${JSON.stringify({ exitCode: receipt.exitCode, signal: receipt.signal, canceled: receipt.canceled, timedOut: receipt.timedOut, errors: receipt.errors, settlement: receipt.settlement })}`
      );
    const output = await Promise.race([
      (options.readVersion ?? ((path: string) => readFile(path, 'utf8')))(
        join(home, 'logs', 'runtime-version.stdout.log')
      ),
      expired,
    ]);
    assertActive();
    if (output === null)
      throw new Error('version output: expected settled read | received: cleanup deadline');
    const version = output.trim();
    if (!version) throw new Error('expected nonempty version output');
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    return version;
  } catch (cause) {
    throw new RuntimeVersionError(
      `${binary} --version failed: ${String(cause)}; retained ${home}`,
      home,
      receipt,
      receipt?.settlement.empty && receipt.settlement.rootObserved ? 'confirmed' : 'unconfirmed',
      cause
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener('abort', cancel);
  }
}
