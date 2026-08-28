/**
 * A scriptable stand-in for `cursor-agent acp`, wired to the production client.
 *
 * The adapter under test is the real one, and so are the JSON-RPC client, the
 * id correlation and the reducer. Only the vendor process is fake — and only
 * the OS boundary, which `external-agent-process.test.ts` already covers.
 *
 * What this exists to exercise is the part a stubbed client could never reach:
 * ACP **asks MangoStudio for permission and blocks until answered**. The
 * approval scenario blocks exactly where the real server blocks, so a turn that
 * never answers hangs here the way it would in production — and the whole turn
 * is one `session/prompt` request whose response is its ending, which is the
 * shape Codex does not have.
 */

import type { ExternalAgentManagedProcess } from '../../src/services/external-agents/process';
import { CURSOR_MODELS, CURSOR_MODES, CURSOR_TRANSCRIPT } from './cursor-fixtures';

export type CursorScenario =
  | 'text'
  | 'permission'
  | 'permission-no-options'
  /** Asks about an ACP session this connection is not holding. */
  | 'permission-foreign-session'
  | 'unknown-additive'
  | 'dangling-tool-call'
  | 'refusal'
  | 'load-rejected'
  | 'no-load-session'
  | 'no-models'
  | 'mode-rejected'
  | 'protocol-mismatch'
  /** The adapter retries by launching a new process, so the harness — not this
   * fake — decides which launch fails. Listed here so a test can name it. */
  | 'flaky-handshake'
  | 'handshake-refused'
  | 'host-tool-call';

export interface FakeCursorOptions {
  readonly scenario?: CursorScenario;
  /** How long `session/prompt` waits before answering, so a cancel can land. */
  readonly promptDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeCursorAcpServer {
  readonly #scenario: CursorScenario;
  readonly #promptDelayMs: number;
  readonly #send: (message: unknown) => void;
  /** Answers the adapter gave to server→client requests, by request id. */
  readonly answers = new Map<string, unknown>();
  /**
   * Replies whose JSON-RPC id was not *identical* to the one asked.
   *
   * A real ACP server matches on the id it sent, and Cursor's are numbers
   * starting at zero — so answering request `0` with `"0"` leaves the vendor
   * blocked forever. Recording the mismatch and unblocking anyway turns that
   * into a failed assertion instead of a hung test.
   */
  readonly idMismatches: unknown[] = [];
  /** Server->client requests still awaiting a reply, by stringified id. */
  readonly #asked = new Map<string, unknown>();
  /** Every method the adapter called, in order. */
  readonly calls: Array<{ method: string; params: unknown }> = [];
  #sessionId = CURSOR_TRANSCRIPT.sessionId;
  #cancelled = false;
  #nextServerRequestId = 0;

  constructor(send: (message: unknown) => void, options: FakeCursorOptions = {}) {
    this.#send = send;
    this.#scenario = options.scenario ?? 'text';
    this.#promptDelayMs = options.promptDelayMs ?? 0;
  }

  called(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }

  paramsFor(method: string): unknown {
    return this.calls.find((call) => call.method === method)?.params;
  }

  receive(line: string): void {
    const message = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      result?: unknown;
      error?: unknown;
    };
    if (message.method === undefined && message.id !== undefined) {
      const key = String(message.id);
      const asked = this.#asked.get(key);
      if (this.#asked.has(key) && !Object.is(asked, message.id)) this.idMismatches.push(message.id);
      this.#asked.delete(key);
      this.answers.set(key, message.error ?? message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    this.calls.push({ method: message.method, params: (message as { params?: unknown }).params });
    void this.#handle(message.id, message.method, (message as { params?: unknown }).params);
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #respond(id: unknown, result: unknown): void {
    this.#send({ jsonrpc: '2.0', id, result });
  }

  #fail(id: unknown, code: number, message: string): void {
    this.#send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Issue a server→client request. Cursor's own ids start at 0, so these do too. */
  #ask(method: string, params: unknown): string {
    const id = this.#nextServerRequestId++;
    this.#asked.set(String(id), id);
    this.#send({ jsonrpc: '2.0', id, method, params });
    return String(id);
  }

  #sessionState(withSessionId: boolean) {
    return {
      ...(withSessionId ? { sessionId: this.#sessionId } : {}),
      modes: CURSOR_MODES,
      ...(this.#scenario === 'no-models' ? {} : { models: CURSOR_MODELS }),
    };
  }

  async #handle(id: unknown, method: string, params: unknown): Promise<void> {
    switch (method) {
      case 'initialize': {
        if (this.#scenario === 'handshake-refused') {
          this.#fail(id, -32000, 'acp refused by fixture');
          return;
        }
        const initialize = { ...CURSOR_TRANSCRIPT.initialize };
        if (this.#scenario === 'protocol-mismatch') initialize.protocolVersion = 99;
        if (this.#scenario === 'no-load-session') {
          initialize.agentCapabilities = {
            ...(initialize.agentCapabilities as Record<string, unknown>),
            loadSession: false,
          };
        }
        this.#respond(id, initialize);
        return;
      }
      case 'session/new':
        // The live vendor announces its slash-command catalog while this very
        // request is in flight — before the client can know the session handle,
        // and long before any turn exists. Reproduced here because that timing
        // is the whole difficulty: an adapter that waits for a turn drops it.
        this.#notify('session/update', {
          sessionId: this.#sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Read a diff (user)' }],
          },
        });
        this.#respond(id, this.#sessionState(true));
        return;
      case 'session/load':
        if (this.#scenario === 'load-rejected') {
          this.#fail(id, -32602, 'Invalid params');
          return;
        }
        this.#sessionId = (params as { sessionId?: string }).sessionId ?? this.#sessionId;
        this.#respond(id, this.#sessionState(false));
        return;
      case 'session/set_mode':
        if (this.#scenario === 'mode-rejected') {
          this.#fail(id, -32603, 'Invalid mode ID: plan. Valid modes: agent, ask');
          return;
        }
        this.#respond(id, {});
        return;
      case 'session/set_model':
        this.#respond(id, {});
        return;
      case 'session/list':
        this.#respond(id, CURSOR_TRANSCRIPT.sessionList);
        return;
      case 'session/prompt':
        this.#respond(id, await this.#runTurn());
        return;
      case 'session/cancel':
        // A notification: recorded for assertions, never answered.
        return;
      default:
        this.#fail(id, -32601, `fixture does not implement ${method}`);
    }
  }

  /** `session/cancel` is a notification; the acknowledgement is the prompt result. */
  cancel(): void {
    this.#cancelled = true;
  }

  async #runTurn(): Promise<{ stopReason: string }> {
    if (this.#promptDelayMs > 0) await sleep(this.#promptDelayMs);

    for (const update of CURSOR_TRANSCRIPT.updates) {
      if (this.#cancelled) return { stopReason: 'cancelled' };
      if (
        this.#scenario === 'permission-no-options' &&
        update.sessionUpdate === 'tool_call_update' &&
        update.status === 'in_progress'
      ) {
        const requestId = this.#ask('session/request_permission', {
          ...CURSOR_TRANSCRIPT.requestPermission,
          options: [],
        });
        while (!this.answers.has(requestId)) await sleep(2);
        continue;
      }
      if (
        this.#scenario === 'permission-foreign-session' &&
        update.sessionUpdate === 'tool_call_update' &&
        update.status === 'in_progress'
      ) {
        const requestId = this.#ask('session/request_permission', {
          ...CURSOR_TRANSCRIPT.requestPermission,
          sessionId: 'a-session-this-connection-never-opened',
        });
        while (!this.answers.has(requestId)) await sleep(2);
        continue;
      }
      if (
        this.#scenario === 'permission' &&
        update.sessionUpdate === 'tool_call_update' &&
        update.status === 'in_progress'
      ) {
        this.#notify('session/update', { sessionId: this.#sessionId, update });
        const requestId = this.#ask(
          'session/request_permission',
          CURSOR_TRANSCRIPT.requestPermission
        );
        // Blocks exactly where the vendor blocks: until MangoStudio answers.
        while (!this.answers.has(requestId)) await sleep(2);
        continue;
      }
      if (
        this.#scenario === 'dangling-tool-call' &&
        update.sessionUpdate === 'tool_call_update' &&
        update.status === 'completed'
      ) {
        // The call is opened and never terminated, which is what a vendor that
        // drops a completion looks like.
        continue;
      }
      this.#notify('session/update', { sessionId: this.#sessionId, update });
    }

    if (this.#scenario === 'unknown-additive') {
      // A variant from an ACP newer than this build, and one for another
      // session on the same connection.
      this.#notify('session/update', {
        sessionId: this.#sessionId,
        update: { sessionUpdate: 'quantum_update', payload: { anything: true } },
      });
      this.#notify('session/update', {
        sessionId: 'some-other-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NOPE' } },
      });
    }

    if (this.#scenario === 'host-tool-call') {
      const requestId = this.#ask('fs/write_text_file', {
        sessionId: this.#sessionId,
        path: '/etc/passwd',
        content: 'nope',
      });
      while (!this.answers.has(requestId)) await sleep(2);
    }

    if (this.#cancelled) return { stopReason: 'cancelled' };
    return { stopReason: this.#scenario === 'refusal' ? 'refusal' : 'end_turn' };
  }
}

export interface FakeCursorProcess {
  readonly managed: ExternalAgentManagedProcess;
  readonly server: FakeCursorAcpServer;
}

/** An `ExternalAgentManagedProcess` whose other end is `FakeCursorAcpServer`. */
export function createFakeCursorProcess(options: FakeCursorOptions = {}): FakeCursorProcess {
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  let terminated = false;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };
  const server = new FakeCursorAcpServer((message) => {
    if (ended) return;
    lines.push(JSON.stringify(message));
    wake();
  }, options);

  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () =>
    undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });

  const managed: ExternalAgentManagedProcess = {
    pid: -1,
    stdout: {
      async next(timeoutMs, signal) {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (true) {
          const line = lines.shift();
          if (line !== undefined) return { kind: 'line', line };
          if (ended) return { kind: 'eof' };
          if (signal?.aborted) {
            throw new DOMException('External agent read cancelled.', 'AbortError');
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { kind: 'timeout' };
          const arrived = await new Promise<boolean>((resolve) => {
            const waiter = () => {
              clearTimeout(timer);
              resolve(true);
            };
            const timer = setTimeout(
              () => {
                waiters.delete(waiter);
                resolve(false);
              },
              Math.min(remaining, 25)
            );
            timer.unref?.();
            waiters.add(waiter);
          });
          if (!arrived && Date.now() >= deadline) return { kind: 'timeout' };
        }
      },
      close() {
        ended = true;
        wake();
      },
    },
    exit,
    writeLine(value) {
      if (terminated) return Promise.reject(new Error('fixture process is gone'));
      const frame = value as { method?: string };
      // `session/cancel` is a notification, so it never reaches `#handle`.
      if (frame.method === 'session/cancel') server.cancel();
      server.receive(JSON.stringify(value));
      return Promise.resolve();
    },
    endInput: () => undefined,
    stderrTail: () => '',
    terminate() {
      terminated = true;
      ended = true;
      wake();
      resolveExit({ code: 0, signal: null });
      return Promise.resolve();
    },
  };

  return { managed, server };
}
