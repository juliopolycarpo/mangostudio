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
  /** Awaited before the *first* `terminal.write` call resolves; later calls are immediate. */
  readonly gateFirstWrite?: () => Promise<unknown>;
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

  readonly #openResult: Partial<RuntimeTerminalOpenResult>;
  readonly #attachResult: Partial<RuntimeTerminalAttachResult>;
  readonly #outputListeners = new Map<string, Set<(event: RuntimeTerminalOutputEvent) => void>>();
  readonly #closeListeners = new Set<() => void>();
  #gateFirstAttach: (() => Promise<unknown>) | undefined;
  #gateFirstWrite: (() => Promise<unknown>) | undefined;

  constructor(options: FakeTerminalRuntimeClientOptions = {}) {
    this.manifest = options.manifest ?? FAKE_TERMINAL_MANIFEST;
    this.#openResult = options.openResult ?? {};
    this.#attachResult = options.attachResult ?? {};
    this.#gateFirstAttach = options.gateFirstAttach;
    this.#gateFirstWrite = options.gateFirstWrite;
  }

  readonly terminal: TerminalRuntimeTerminalClient = {
    open: (params) => {
      this.calls.open.push(params);
      return Promise.resolve({
        sessionId: params.sessionId,
        shell: params.shell ?? 'bash',
        cwd: params.cwd ?? '/home/tester',
        pid: 4242,
        ...this.#openResult,
      });
    },
    attach: async (params) => {
      this.calls.attach.push(params);
      const gate = this.#gateFirstAttach;
      this.#gateFirstAttach = undefined;
      if (gate) await gate();
      return {
        sessionId: params.sessionId,
        scrollback: '',
        status: 'running' as const,
        exitCode: null,
        signal: null,
        cols: 80,
        rows: 24,
        ...this.#attachResult,
      };
    },
    detach: (params) => {
      this.calls.detach.push(params);
      return Promise.resolve({ ok: true as const });
    },
    write: async (params) => {
      this.calls.write.push(params);
      const gate = this.#gateFirstWrite;
      this.#gateFirstWrite = undefined;
      if (gate) await gate();
      return { ok: true as const };
    },
    resize: (params) => {
      this.calls.resize.push(params);
      return Promise.resolve({ ok: true as const });
    },
    ack: (params) => {
      this.calls.ack.push(params);
      return Promise.resolve({ ok: true as const });
    },
    close: (params) => {
      this.calls.close.push(params);
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
