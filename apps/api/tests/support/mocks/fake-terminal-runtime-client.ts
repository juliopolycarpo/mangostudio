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
  RuntimeTerminalWriteParams,
} from '@mangostudio/runtime';
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
  },
  terminal: true,
};

export interface FakeTerminalRuntimeClientOptions {
  readonly manifest?: RuntimeCapabilityManifest;
  readonly openResult?: Partial<RuntimeTerminalOpenResult>;
  readonly attachResult?: Partial<RuntimeTerminalAttachResult>;
  /** Awaited before the *first* `terminal.attach` call resolves; later calls are immediate. */
  readonly gateFirstAttach?: () => Promise<unknown>;
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
  #gateFirstDetach: (() => Promise<unknown>) | undefined;
  #gateFirstWrite: (() => Promise<unknown>) | undefined;
  #outputWithAttachResponse: readonly RuntimeTerminalOutputEvent[] | undefined;

  constructor(options: FakeTerminalRuntimeClientOptions = {}) {
    this.manifest = options.manifest ?? FAKE_TERMINAL_MANIFEST;
    this.#openResult = options.openResult ?? {};
    this.#attachResult = options.attachResult ?? {};
    this.#gateFirstAttach = options.gateFirstAttach;
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
    open: (params) => {
      this.#record('open', params);
      return Promise.resolve({
        sessionId: params.sessionId,
        shell: params.shell ?? 'bash',
        cwd: params.cwd ?? '/home/tester',
        pid: 4242,
        ...this.#openResult,
      });
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
    close: (params) => {
      this.#record('close', params);
      return Promise.resolve({ ok: true as const });
    },
    list: () => Promise.resolve({ sessions: [] }),
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
}
