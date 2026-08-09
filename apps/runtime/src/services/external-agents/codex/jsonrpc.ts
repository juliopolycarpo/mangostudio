/**
 * A JSON-RPC peer over the vendor process's stdio, in both directions.
 *
 * "Both directions" is the requirement that shaped it. Codex does not merely
 * stream at the client — it *asks the client things*, and blocks until it gets
 * an answer: five approval requests plus `item/tool/call`. A codec that only
 * turned lines into events could never reply, which is why plan 003's adapter
 * interface is semantic rather than a reducer, and why correlating request ids
 * is the adapter's job rather than the supervisor's.
 *
 * The framing, byte caps and process-tree teardown all belong to the supervisor's
 * `ExternalAgentManagedProcess`; this only speaks the protocol on top of them.
 */

import type { ExternalAgentManagedProcess } from '../process';

/** How long a single pump read waits before looping to re-check liveness. */
const PUMP_POLL_MS = 250;

export interface CodexJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A failed JSON-RPC call, with the vendor's own structure intact. */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly requestId: string;

  constructor(method: string, requestId: string, error: CodexJsonRpcError) {
    super(error.message);
    this.name = 'CodexRpcError';
    this.code = error.code;
    this.data = error.data;
    this.requestId = requestId;
    this.method = method;
  }

  readonly method: string;
}

/** What a server→client request handler answers with. */
export type CodexServerRequestOutcome =
  | { readonly result: unknown }
  | { readonly error: CodexJsonRpcError };

export interface CodexJsonRpcHandlers {
  onNotification(method: string, params: unknown): void;
  /**
   * Answers a server→client request.
   *
   * A handler that throws still produces an error frame: leaving a server
   * request unanswered blocks the vendor on a reply that never arrives, which
   * presents as a hung turn rather than as the failure it is.
   */
  onServerRequest(
    method: string,
    params: unknown,
    requestId: string
  ): Promise<CodexServerRequestOutcome> | CodexServerRequestOutcome;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexJsonRpcClient {
  readonly #process: ExternalAgentManagedProcess;
  readonly #handlers: CodexJsonRpcHandlers;
  readonly #pending = new Map<string, Pending>();
  readonly #pump: Promise<void>;
  #nextId = 1;
  #stopped = false;
  #failure?: Error;

  constructor(managed: ExternalAgentManagedProcess, handlers: CodexJsonRpcHandlers) {
    this.#process = managed;
    this.#handlers = handlers;
    this.#pump = this.#run();
  }

  /** Whatever stderr the vendor produced, bounded and credential-redacted. */
  stderrTail(): string {
    return this.#process.stderrTail();
  }

  async request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.#failure) throw this.#failure;
    if (this.#stopped) throw new Error('The Codex app-server connection is closed.');
    const id = String(this.#nextId++);

    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
    });
    try {
      await this.#process.writeLine({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      // The entry has to go before the throw. Nothing is awaiting `settled` on
      // this path — the failure leaves through `writeLine` — so a later
      // `close()` or a dying pump rejecting the orphan would surface as an
      // unhandled rejection that can take the runtime process down, on top of
      // leaking the entry for a call the vendor never received.
      this.#pending.delete(id);
      settled.catch(() => undefined);
      throw error;
    }

    const timer = setTimeout(() => {
      this.#settle(id, (pending) =>
        pending.reject(new Error(`Codex "${method}" did not answer within ${timeoutMs}ms.`))
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      this.#settle(id, (pending) => pending.reject(new Error(`Codex "${method}" was cancelled.`)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return (await settled) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.#stopped) return;
    await this.#process.writeLine({ jsonrpc: '2.0', method, params });
  }

  /** Stops the pump and fails every in-flight call; the process is the caller's to reap. */
  async close(): Promise<void> {
    this.#stopped = true;
    this.#process.stdout.close();
    this.#rejectAll(new Error('The Codex app-server connection was closed.'));
    await this.#pump;
  }

  #settle(id: string, apply: (pending: Pending) => void): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    apply(pending);
  }

  #rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(error));
    }
  }

  async #run(): Promise<void> {
    try {
      while (!this.#stopped) {
        const read = await this.#process.stdout.next(PUMP_POLL_MS);
        if (read.kind === 'timeout') continue;
        if (read.kind === 'eof') {
          this.#failure ??= new Error(
            `The Codex app-server exited. ${this.#process.stderrTail()}`.trim()
          );
          this.#rejectAll(this.#failure);
          return;
        }
        await this.#dispatch(read.line);
      }
    } catch (error) {
      this.#failure ??= error instanceof Error ? error : new Error(String(error));
      this.#rejectAll(this.#failure);
    }
  }

  async #dispatch(line: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') return;
      message = parsed as Record<string, unknown>;
    } catch {
      // Not every line on a vendor's stdout is a frame. Dropping an unparseable
      // one keeps a stray diagnostic from killing a live turn.
      return;
    }

    const id = message.id;
    const method = message.method;

    if (typeof method === 'string' && id === undefined) {
      this.#handlers.onNotification(method, message.params);
      return;
    }
    if (typeof method === 'string') {
      await this.#answer(String(id), method, message.params);
      return;
    }
    if (id === undefined) return;

    this.#settle(String(id), (pending) => {
      const error = message.error;
      if (error && typeof error === 'object') {
        pending.reject(
          new CodexRpcError(pending.method, String(id), error as unknown as CodexJsonRpcError)
        );
        return;
      }
      pending.resolve(message.result);
    });
  }

  async #answer(id: string, method: string, params: unknown): Promise<void> {
    let outcome: CodexServerRequestOutcome;
    try {
      outcome = await this.#handlers.onServerRequest(method, params, id);
    } catch (error) {
      outcome = {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    try {
      await this.#process.writeLine({ jsonrpc: '2.0', id, ...outcome });
    } catch {
      // The process died between the request and our reply; `#run` surfaces it.
    }
  }
}
