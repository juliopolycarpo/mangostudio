import { type AddressInfo, createConnection, createServer, type Socket } from 'node:net';

import { fixtureChildEnvironment } from './child-supervision';
import { readNativeFormatterProcess } from './formatter-process-settlement';
import { isAlive } from './process-liveness';

export const DRAIN_CHANNEL_ENV = 'MANGOSTUDIO_FAKE_DRAIN_CHANNEL';
const CHANNEL_TIMEOUT_MS = 2_000;

/**
 * Require the observed orphan to keep its inherited pipes open.
 * @example assertDrainPipeHolder(pid, fixture.holdingPipes, isAlive);
 */
export function assertDrainPipeHolder(
  pid: number,
  holdingPipes: boolean,
  readNativeAlive: (pid: number) => boolean
): void {
  if (!holdingPipes) {
    throw new Error(`drain fixture PID ${pid}: expected holding pipes: true | received false`);
  }
  if (!readNativeAlive(pid)) {
    throw new Error(
      `drain fixture PID ${pid}: expected native process alive: true | received false`
    );
  }
}

/** Cleanup authority for the pipe-holder fixture, independent of reported PIDs. */
export interface DrainFixtureOwner {
  close(): Promise<void>;
}

export interface LiveDrainFixture extends DrainFixtureOwner {
  readonly env: NodeJS.ProcessEnv;
  readonly holdingPipes: boolean;
  /** PID received over the authenticated channel, if any. */
  readonly nativePid?: number;
  /** Retained cooperative connection and listener closure, not a native process receipt. */
  readonly settled: boolean;
  ready(): Promise<number>;
}

export interface DrainFixtureActions<Context, Result> {
  start(): Promise<Context>;
  readPid(context: Context): number;
  check(context: Context, pid: number): Result | Promise<Result>;
}

/**
 * Run a drain fixture's observations before releasing its cleanup authority.
 * @example await withOwnedDrainFixture(owner, { start, readPid, check });
 */
export async function withOwnedDrainFixture<Context, Result>(
  owner: DrainFixtureOwner,
  actions: DrainFixtureActions<Context, Result>
): Promise<Result> {
  let result: { ok: true; value: Result } | { ok: false; error: unknown };
  try {
    const context = await actions.start();
    const pid = actions.readPid(context);
    result = { ok: true, value: await actions.check(context, pid) };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await owner.close();
  } catch (cleanup) {
    if (result.ok) throw cleanup;
    throw new AggregateError([result.error, cleanup], 'drain fixture and cleanup failed', {
      cause: result.error,
    });
  }
  if (!result.ok) throw result.error;
  return result.value;
}

async function within<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label}: expected settlement within ${timeoutMs}ms | received timeout`)
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Own a private cooperative channel before a worker can create its pipe-holder.
 * Closing the listener prevents late starts; EOF settles the retained connection.
 * The worker intentionally exits first, so its handle cannot own this orphan's cleanup.
 * Existing worker settlement is absent on Windows; a PID or process group recorded
 * before the worker exits can be reused and cannot safely authorize a later signal.
 * @example const fixture = await createDrainFixture(); await fixture.close();
 */
export async function createDrainFixture(
  timeoutMs = CHANNEL_TIMEOUT_MS
): Promise<LiveDrainFixture> {
  const token = crypto.randomUUID();
  const ready = Promise.withResolvers<number>();
  void ready.promise.catch(() => undefined);
  const sockets = new Set<Socket>();
  let owned: Socket | undefined;
  let nativePid: number | undefined;
  let ownedClosed = Promise.resolve();
  let closing = false;
  let settled = false;
  let stopping: Promise<void> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    const handshake = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => {
      sockets.delete(socket);
      clearTimeout(handshake);
    });
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk: string) => {
      if (closing) return void socket.destroy();
      if (owned === socket) return;
      input += chunk;
      if (input.length > 1024) return void socket.destroy();
      const end = input.indexOf('\n');
      if (end < 0) return;
      const [supplied, rawPid, extra] = input.slice(0, end).split(' ');
      const pid = Number(rawPid);
      if (
        supplied !== token ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        extra !== undefined ||
        owned
      )
        return void socket.destroy();
      owned = socket;
      nativePid = pid;
      ownedClosed = new Promise<void>((resolve) => socket.once('close', resolve));
      clearTimeout(handshake);
      ready.resolve(pid);
      socket.write(`owned ${token}\n`);
    });
  });
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }),
      timeoutMs,
      'drain fixture listener'
    );
  } catch (error) {
    closing = true;
    server.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  return {
    env: { [DRAIN_CHANNEL_ENV]: `${port} ${token}` },
    get holdingPipes() {
      return owned !== undefined && !owned.destroyed;
    },
    get nativePid() {
      return nativePid;
    },
    get settled() {
      return settled;
    },
    ready() {
      if (closing)
        return Promise.reject(new Error('drain fixture readiness requested after cleanup'));
      return within(ready.promise, timeoutMs, 'drain fixture readiness');
    },
    close() {
      if (stopping) return stopping;
      closing = true;
      ready.reject(new Error('drain fixture closed before readiness'));
      stopping = (async () => {
        const listenerClosed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        for (const socket of sockets) if (socket !== owned) socket.destroy();
        if (owned && !owned.destroyed) owned.write('stop\n');
        try {
          await within(
            Promise.all([ownedClosed, listenerClosed]),
            timeoutMs,
            'drain fixture closure'
          );
          settled = true;
        } finally {
          for (const socket of sockets) socket.destroy();
        }
      })();
      return stopping;
    },
  };
}

function channel(env: NodeJS.ProcessEnv): { port: number; token: string } {
  const value = env[DRAIN_CHANNEL_ENV];
  const [rawPort, token, extra] = value?.split(' ') ?? [];
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !token || extra !== undefined)
    throw new Error(
      `${DRAIN_CHANNEL_ENV}: expected port and private token | received ${JSON.stringify(value)}`
    );
  return { port, token };
}

/**
 * Start the deliberately inherited pipe-holder and retain its handle until ready.
 * Startup failure stops and awaits that exact child before rejecting.
 * @example const child = await startDrainPipeHolder(); child.unref();
 */
export async function startDrainPipeHolder(
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onStarted?: (child: Bun.Subprocess) => void;
  } = {}
) {
  const env = fixtureChildEnvironment(options.env ?? process.env);
  channel(env);
  const timeoutMs = options.timeoutMs ?? CHANNEL_TIMEOUT_MS;
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path],
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message) {
      if (message === 'drain-ready') ready.resolve();
      else
        ready.reject(
          new Error(`drain pipe-holder: expected readiness | received ${String(message)}`)
        );
    },
  });
  try {
    options.onStarted?.(child);
    await within(
      Promise.race([
        ready.promise,
        child.exited.then((code) => {
          throw new Error(`drain pipe-holder: expected readiness | received exit ${code}`);
        }),
      ]),
      timeoutMs,
      'drain pipe-holder readiness'
    );
    child.disconnect();
    return child;
  } catch (primary) {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
      await within(child.exited, timeoutMs, 'drain pipe-holder startup cleanup');
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], 'drain pipe-holder startup and cleanup failed', {
        cause: primary,
      });
    }
    throw primary;
  }
}

function holdPipes(): void {
  const { port, token } = channel(process.env);
  const socket = createConnection({ host: '127.0.0.1', port });
  let authenticated = false;
  let input = '';
  const timer = setTimeout(() => process.exit(1), CHANNEL_TIMEOUT_MS);
  socket.setNoDelay(true);
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(`${token} ${process.pid}\n`));
  socket.on('error', () => process.exit(1));
  socket.once('close', () => process.exit(authenticated ? 0 : 1));
  socket.on('data', (chunk: string) => {
    input += chunk;
    const lines = input.split('\n');
    input = lines.pop() ?? '';
    for (const line of lines) {
      if (line === 'stop') process.exit(0);
      if (line !== `owned ${token}` || authenticated) process.exit(1);
      authenticated = true;
      clearTimeout(timer);
      process.send?.('drain-ready');
    }
  });
}

if (import.meta.main) holdPipes();

interface DrainScopeHost {
  create(): Promise<LiveDrainFixture>;
  readNativeAlive(pid: number, timeoutMs: number): Promise<boolean>;
  now(): number;
  pause(ms: number): Promise<void>;
}

const DRAIN_SCOPE_HOST: DrainScopeHost = {
  create: () => createDrainFixture(),
  async readNativeAlive(pid, timeoutMs) {
    if (process.platform === 'win32') return isAlive(pid);
    const current = await readNativeFormatterProcess(pid, timeoutMs);
    return current !== undefined && isAlive(pid, () => current.state);
  },
  now: () => performance.now(),
  pause: (ms) => Bun.sleep(ms),
};

/**
 * Own channel allocation and native pipe-holder settlement across test teardown.
 * @example const scope = new DrainFixtureScope(controller.signal); const channel = await scope.allocate();
 */
export class DrainFixtureScope implements DrainFixtureOwner {
  private allocation?: Promise<LiveDrainFixture>;
  private closing?: Promise<void>;
  private laneStarted = false;
  private readonly completion = Promise.withResolvers<void>();
  readonly closed = this.completion.promise;

  constructor(
    private readonly signal: AbortSignal,
    private readonly host: DrainScopeHost = DRAIN_SCOPE_HOST,
    private readonly timeoutMs = CHANNEL_TIMEOUT_MS
  ) {
    void this.closed.catch(() => undefined);
    if (signal.aborted) void this.close();
    else signal.addEventListener('abort', this.onAbort, { once: true });
  }

  private readonly onAbort = () => {
    void this.close().catch(() => undefined);
  };

  /** Allocate once and refuse a continuation after cleanup, for example `await scope.allocate()`. */
  allocate(): Promise<LiveDrainFixture> {
    this.signal.throwIfAborted();
    if (this.allocation || this.closing)
      return Promise.reject(new Error('drain fixture already allocated or closing'));
    this.allocation = this.host.create();
    return this.allocation.then((fixture) => {
      this.signal.throwIfAborted();
      if (this.closing) throw new Error('drain fixture closed during allocation');
      return fixture;
    });
  }

  /** Mark the lane before it may spawn a pipe-holder, for example `scope.markLaneStarted()`. */
  markLaneStarted(): void {
    this.signal.throwIfAborted();
    if (this.closing) throw new Error('drain fixture is closing');
    this.laneStarted = true;
  }

  /** Close the cooperative channel and separately prove native absence, for example `await scope.close()`. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.signal.removeEventListener('abort', this.onAbort);
    this.closing = this.closeOnce();
    void this.closing.then(
      () => this.completion.resolve(),
      (error: unknown) => this.completion.reject(error)
    );
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    if (!this.allocation) return;
    let fixture: LiveDrainFixture;
    try {
      fixture = await within(this.allocation, this.timeoutMs, 'drain fixture allocation cleanup');
    } catch (error) {
      // If allocation completes after the deadline, still close its channel; the
      // original failure retains storage because this cleanup was not proven.
      void this.allocation.then((late) => late.close()).catch(() => undefined);
      throw error;
    }
    await fixture.close();
    if (!this.laneStarted) return;
    const pid = fixture.nativePid;
    if (pid === undefined)
      throw new Error(
        'drain fixture: expected authenticated native PID | received none; storage retained'
      );
    const deadline = this.host.now() + this.timeoutMs;
    while (true) {
      const remaining = Math.floor(deadline - this.host.now());
      if (remaining < 1)
        throw new Error(
          `drain fixture PID ${pid}: expected native exit within ${this.timeoutMs}ms | received unconfirmed; storage retained`
        );
      const budget = Math.min(300, remaining);
      const live = await within(
        this.host.readNativeAlive(pid, budget),
        budget + 1000,
        'drain fixture native observation'
      );
      if (this.host.now() > deadline)
        throw new Error(
          `drain fixture PID ${pid}: expected native exit within ${this.timeoutMs}ms | received late observation; storage retained`
        );
      if (!live) return;
      await this.host.pause(Math.min(25, Math.max(0, deadline - this.host.now())));
    }
  }
}
