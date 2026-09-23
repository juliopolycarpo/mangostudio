/**
 * Named fake standing in for `RuntimeClient` in terminal-service tests: it
 * records every `terminal.*` call, and lets a test emit `terminal.output`
 * events or fire the connection's `onClose` the way a real runtime and a
 * dropped connection would.
 */

import type {
  RuntimeCapabilityManifest,
  RuntimeTerminalAckParams,
  RuntimeTerminalAttachParams,
  RuntimeTerminalAttachResult,
  RuntimeTerminalCloseParams,
  RuntimeTerminalDetachParams,
  RuntimeTerminalOpenParams,
  RuntimeTerminalOpenResult,
  RuntimeTerminalOutputEvent,
  RuntimeTerminalResizeParams,
  RuntimeTerminalSessionSummary,
  RuntimeTerminalWriteParams,
} from '@mangostudio/shared/runtime-contract';
import type {
  TerminalRuntimeClient,
  TerminalRuntimeTerminalClient,
} from '../../../src/modules/terminals/domain/terminal-runtime-client';

export const FAKE_TERMINAL_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/tester',
  shells: ['bash'],
  git: { available: true, version: '2.44.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
    toolchain: true,
  },
  terminal: true,
  terminalCloseAfterRevocation: true,
};

export interface FakeTerminalRuntimeClientOptions {
  readonly manifest?: RuntimeCapabilityManifest;
  readonly openResult?: Partial<RuntimeTerminalOpenResult>;
  readonly attachResult?: Partial<RuntimeTerminalAttachResult>;
  /** Awaited before the *first* `terminal.attach` call resolves; later calls are immediate. */
  readonly gateFirstAttach?: () => Promise<unknown>;
  /** Awaited before the first open resolves, after recording its request. */
  readonly gateFirstOpen?: () => Promise<unknown>;
  readonly failFirstOpen?: Error;
  readonly failFirstClose?: Error;
  /** Refuses each close while the test's runtime cleanup gate remains closed. */
  readonly closeFailure?: () => Error | undefined;
  /** Awaited before the first close settles, after recording its request. */
  readonly gateFirstClose?: () => Promise<unknown>;
  readonly gateFirstList?: () => Promise<unknown>;
  /** Awaited before the *first* `terminal.detach` call resolves; later calls are immediate. */
  readonly gateFirstDetach?: () => Promise<unknown>;
  /** Awaited before the *first* `terminal.write` call resolves; later calls are immediate. */
  readonly gateFirstWrite?: () => Promise<unknown>;
  /**
   * Frames the runtime emits in the same read as the *first* `terminal.attach`
   * response. A real frame port dispatches a batch synchronously, so these
   * reach listeners before the hub's `await` on the response resumes — the
   * window in which an unsubscribed hub loses them.
   */
  readonly outputWithFirstAttachResponse?: readonly RuntimeTerminalOutputEvent[];
}

/** One recorded call, for assertions about how two sockets interleaved. */
export interface FakeTerminalCall {
  readonly method: 'open' | 'attach' | 'detach' | 'write' | 'resize' | 'ack' | 'close';
  readonly sessionId: string;
}

export class FakeTerminalRuntimeClient implements TerminalRuntimeClient {
  readonly manifest: RuntimeCapabilityManifest;
  readonly calls: {
    readonly open: RuntimeTerminalOpenParams[];
    readonly attach: RuntimeTerminalAttachParams[];
    readonly detach: RuntimeTerminalDetachParams[];
    readonly write: RuntimeTerminalWriteParams[];
    readonly resize: RuntimeTerminalResizeParams[];
    readonly ack: RuntimeTerminalAckParams[];
    readonly close: RuntimeTerminalCloseParams[];
  } = { open: [], attach: [], detach: [], write: [], resize: [], ack: [], close: [] };
  /** The same calls in one list, in the order they were made. */
  readonly sequence: FakeTerminalCall[] = [];

  readonly #openResult: Partial<RuntimeTerminalOpenResult>;
  readonly #attachResult: Partial<RuntimeTerminalAttachResult>;
  readonly #outputListeners = new Map<string, Set<(event: RuntimeTerminalOutputEvent) => void>>();
  readonly #closeListeners = new Set<() => void>();
  readonly #callWaiters = new Set<{
    readonly method: FakeTerminalCall['method'];
    readonly resolve: () => void;
  }>();
  #gateFirstAttach: (() => Promise<unknown>) | undefined;
  #gateFirstOpen: (() => Promise<unknown>) | undefined;
  #failFirstOpen: Error | undefined;
  #failFirstClose: Error | undefined;
  readonly #closeFailure: (() => Error | undefined) | undefined;
  #gateFirstClose: (() => Promise<unknown>) | undefined;
  #gateFirstList: (() => Promise<unknown>) | undefined;
  readonly #sessions = new Map<string, RuntimeTerminalSessionSummary>();
  readonly requestOptions = {
    open: [] as Array<{ timeoutMs?: number } | undefined>,
    close: [] as Array<{ timeoutMs?: number } | undefined>,
    list: [] as Array<{ timeoutMs?: number } | undefined>,
  };
  #gateFirstDetach: (() => Promise<unknown>) | undefined;
  #gateFirstWrite: (() => Promise<unknown>) | undefined;
  #outputWithAttachResponse: readonly RuntimeTerminalOutputEvent[] | undefined;

  constructor(options: FakeTerminalRuntimeClientOptions = {}) {
    this.manifest = options.manifest ?? FAKE_TERMINAL_MANIFEST;
    this.#openResult = options.openResult ?? {};
    this.#attachResult = options.attachResult ?? {};
    this.#gateFirstAttach = options.gateFirstAttach;
    this.#gateFirstOpen = options.gateFirstOpen;
    this.#failFirstOpen = options.failFirstOpen;
    this.#failFirstClose = options.failFirstClose;
    this.#closeFailure = options.closeFailure;
    this.#gateFirstClose = options.gateFirstClose;
    this.#gateFirstList = options.gateFirstList;
    this.#gateFirstDetach = options.gateFirstDetach;
    this.#gateFirstWrite = options.gateFirstWrite;
    this.#outputWithAttachResponse = options.outputWithFirstAttachResponse;
  }

  /** Records a call in both the per-method list and the global order. */
  #record<M extends FakeTerminalCall['method']>(
    method: M,
    params: { readonly sessionId: string }
  ): void {
    (this.calls[method] as { readonly sessionId: string }[]).push(params);
    this.sequence.push({ method, sessionId: params.sessionId });
    for (const waiter of [...this.#callWaiters]) {
      if (waiter.method !== method) continue;
      this.#callWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  /**
   * Resolves the next time `method` is called. Lets one socket's gate release
   * on another socket's progress, so a race can be staged without a sleep that
   * would hand the event loop the very turn the race is about.
   */
  waitForCall(method: FakeTerminalCall['method']): Promise<void> {
    return new Promise((resolve) => {
      this.#callWaiters.add({ method, resolve });
    });
  }

  readonly terminal: TerminalRuntimeTerminalClient = {
    open: async (params, options) => {
      this.#record('open', params);
      this.requestOptions.open.push(options);
      const gate = this.#gateFirstOpen;
      this.#gateFirstOpen = undefined;
      if (gate) await gate();
      const failure = this.#failFirstOpen;
      this.#failFirstOpen = undefined;
      if (failure) throw failure;
      const result = {
        sessionId: params.sessionId,
        shell: params.shell ?? 'bash',
        cwd: params.cwd ?? '/home/tester',
        pid: 4242,
        ...this.#openResult,
      };
      this.#sessions.set(params.sessionId, {
        ...result,
        cols: params.cols,
        rows: params.rows,
        status: 'running',
        exitCode: null,
        signal: null,
        attached: false,
      });
      return result;
    },
    attach: async (params) => {
      this.#record('attach', params);
      const gate = this.#gateFirstAttach;
      this.#gateFirstAttach = undefined;
      if (gate) await gate();
      const result = {
        sessionId: params.sessionId,
        scrollback: '',
        status: 'running' as const,
        exitCode: null,
        signal: null,
        cols: 80,
        rows: 24,
        ...this.#attachResult,
      };

      const batched = this.#outputWithAttachResponse;
      this.#outputWithAttachResponse = undefined;
      if (!batched) return result;
      // Settling first and emitting after is what puts these frames ahead of
      // the caller's continuation, the way one read carrying `res` then `evt`
      // does on a real port.
      return new Promise((resolve) => {
        resolve(result);
        for (const event of batched) this.emitOutput(params.sessionId, event);
      });
    },
    detach: async (params) => {
      this.#record('detach', params);
      const gate = this.#gateFirstDetach;
      this.#gateFirstDetach = undefined;
      if (gate) await gate();
      return { ok: true as const };
    },
    write: async (params) => {
      this.#record('write', params);
      const gate = this.#gateFirstWrite;
      this.#gateFirstWrite = undefined;
      if (gate) await gate();
      return { ok: true as const };
    },
    resize: (params) => {
      this.#record('resize', params);
      return Promise.resolve({ ok: true as const });
    },
    ack: (params) => {
      this.#record('ack', params);
      return Promise.resolve({ ok: true as const });
    },
    close: async (params, options) => {
      this.#record('close', params);
      this.requestOptions.close.push(options);
      const gate = this.#gateFirstClose;
      this.#gateFirstClose = undefined;
      if (gate) await gate();
      const failure = this.#failFirstClose;
      this.#failFirstClose = undefined;
      if (failure) throw failure;
      const ongoingFailure = this.#closeFailure?.();
      if (ongoingFailure) throw ongoingFailure;
      this.#sessions.delete(params.sessionId);
      return { ok: true as const };
    },
    list: async (options) => {
      this.requestOptions.list.push(options);
      const sessions = [...this.#sessions.values()].map((session) => ({ ...session }));
      const gate = this.#gateFirstList;
      this.#gateFirstList = undefined;
      if (gate) await gate();
      return { sessions };
    },
    onOutput: (sessionId, listener) => {
      let listeners = this.#outputListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        this.#outputListeners.set(sessionId, listeners);
      }
      listeners.add(listener);
      return () => listeners?.delete(listener);
    },
  };

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** Simulates a `terminal.output` frame for a session an `onOutput` listener is attached to. */
  emitOutput(sessionId: string, event: RuntimeTerminalOutputEvent): void {
    for (const listener of this.#outputListeners.get(sessionId) ?? []) listener(event);
  }

  /** Simulates this connection dropping — what `RuntimeClient.onClose` fires on. */
  fireClose(): void {
    for (const listener of [...this.#closeListeners]) listener();
  }

  /** Changes the state returned by terminal.list without emitting a viewer event. */
  setSessionExit(sessionId: string, exitCode: number): void {
    const session = this.#sessions.get(sessionId);
    if (session) this.#sessions.set(sessionId, { ...session, status: 'exited', exitCode });
  }
}
