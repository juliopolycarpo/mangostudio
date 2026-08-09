import {
  assertRuntimeProtocolCompatible,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCapabilityManifest,
  type RuntimeErrorPayload,
  type RuntimeFrame,
  type RuntimeProtocolVersion,
  type RuntimeRequestFrame,
} from '@mangostudio/shared/runtime-protocol';
import type { RuntimeAuditOutcome, RuntimeAuditSink } from './audit-log';
import { RuntimeServiceError, RuntimeUpdateError } from './errors';
import type { RuntimeFramePort } from './transport';

export interface RuntimeHandlerContext {
  readonly signal: AbortSignal;
}

export type RuntimeMethodHandler = (
  params: unknown,
  context: RuntimeHandlerContext
) => Promise<unknown>;

export interface RuntimeHostOptions {
  readonly runtimeVersion: string;
  /**
   * Capability announcement for `hello`. A factory is evaluated at `start()`
   * rather than at construction, so a host built before its consent source was
   * last read announces the newer snapshot. It is a snapshot either way: the
   * factory is synchronous and cannot touch disk, so consent that changes after
   * `hello` is caught by the dispatch gate and by `runtime.health`, not here.
   */
  readonly manifest: RuntimeCapabilityManifest | (() => RuntimeCapabilityManifest);
  readonly handlers: ReadonlyMap<string, RuntimeMethodHandler>;
  readonly protocolVersion?: RuntimeProtocolVersion;
  /**
   * Releases whatever the handlers hold open beyond a single request — MCP
   * sessions, and their child processes. Fired once, on close: a handler map
   * with state of its own has no other way to learn the host is going away.
   */
  readonly onClose?: () => void | Promise<void>;
  /** True between update.begin and update.commit; all other calls are refused. */
  readonly isUpdateActive?: () => boolean;
  /**
   * Local receipt of what this connection's hub asked for. Enforcement and
   * evidence share this dispatch path so they cannot drift apart. Absent means
   * the slot has auditing off (the `host` default).
   */
  readonly audit?: RuntimeAuditSink;
}

export interface RuntimeEventInput {
  readonly topic: string;
  readonly payload: unknown;
  /** Correlates one multi-frame stream; sequence numbers are per stream. */
  readonly streamId?: string;
  /** Marks the last frame of a stream. */
  readonly end?: true;
}

/** Dispatches protocol requests and owns the cancellation controller per call. */
export class RuntimeHost {
  readonly #activeRequests = new Map<string, AbortController>();
  readonly #activeUpdateRequests = new Set<string>();
  readonly #eventSequences = new Map<string, number>();
  readonly #pongListeners = new Set<() => void>();
  readonly #handlers: ReadonlyMap<string, RuntimeMethodHandler>;
  readonly #resolveManifest: () => RuntimeCapabilityManifest;
  readonly #protocolVersion: RuntimeProtocolVersion;
  readonly #runtimeVersion: string;
  readonly #onClose?: () => void | Promise<void>;
  readonly #isUpdateActive: () => boolean;
  readonly #audit?: RuntimeAuditSink;
  #closePromise?: Promise<void>;
  #detach?: () => void;
  #handshake = deferredHandshake();
  #port?: RuntimeFramePort;
  #ready = false;

  constructor(options: RuntimeHostOptions) {
    this.#runtimeVersion = options.runtimeVersion;
    const manifest = options.manifest;
    this.#resolveManifest = typeof manifest === 'function' ? manifest : () => manifest;
    this.#handlers = options.handlers;
    this.#protocolVersion = options.protocolVersion ?? RUNTIME_PROTOCOL_VERSION;
    if (options.onClose) this.#onClose = options.onClose;
    this.#isUpdateActive = options.isUpdateActive ?? (() => false);
    if (options.audit) this.#audit = options.audit;
  }

  attach(port: RuntimeFramePort): void {
    this.#detach?.();
    this.#port = port;
    // A reconnect handshakes again, so the previous connection's promise must
    // not answer for the new one.
    this.#handshake.reject(new Error('Runtime host was reattached to a new transport.'));
    this.#handshake = deferredHandshake();
    this.#ready = false;
    this.#audit?.setHub(null);
    this.#detach = port.onFrame((frame) => this.#receive(frame));
  }

  /**
   * Resolves once the hub acknowledged the handshake. Anything the runtime
   * pushes — events, heartbeats — has to wait for this: the hub cannot
   * attribute a frame it has not finished agreeing a protocol version for.
   */
  waitUntilReady(): Promise<void> {
    return this.#handshake.promise;
  }

  start(): void {
    if (!this.#port) throw new Error('Runtime host is not attached to a transport.');
    try {
      this.#send({
        type: 'hello',
        protocolVersion: this.#protocolVersion,
        runtimeVersion: this.#runtimeVersion,
        manifest: this.#resolveManifest(),
      });
    } catch (error) {
      // The transport can go away between attach and start — a hub that
      // refuses the credential closes the socket the moment it opens. That is
      // a handshake that will not happen, not a programming error, so it
      // settles the promise callers are already waiting on.
      this.#handshake.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Publishes an event to the hub. Sequence numbers are per stream so a
   * consumer can tell a gap from a reorder; ending a stream releases its
   * counter, which is what keeps a long-lived runtime from accumulating one
   * entry per tool call it ever streamed.
   */
  emit(event: RuntimeEventInput): void {
    // Nothing application-level travels before the handshake settles: the hub
    // has no listeners attached yet and could not attribute the frame.
    if (!this.#ready) return;
    const key = event.streamId ?? event.topic;
    const seq = this.#eventSequences.get(key) ?? 0;
    if (event.end) this.#eventSequences.delete(key);
    else this.#eventSequences.set(key, seq + 1);

    this.#send({
      type: 'evt',
      topic: event.topic,
      seq,
      ...(event.streamId ? { streamId: event.streamId } : {}),
      payload: event.payload,
      ...(event.end ? { end: true as const } : {}),
    });
  }

  /** Sends a protocol ping. The peer answers with `pong`. */
  ping(): void {
    this.#send({ type: 'ping' });
  }

  onPong(listener: () => void): () => void {
    this.#pongListeners.add(listener);
    return () => this.#pongListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const completion = Promise.withResolvers<void>();
    this.#closePromise = completion.promise;
    this.#detach?.();
    this.#detach = undefined;
    for (const controller of this.#activeRequests.values()) controller.abort();
    this.#activeRequests.clear();
    this.#eventSequences.clear();
    this.#pongListeners.clear();
    this.#port?.close();
    this.#port = undefined;
    this.#ready = false;
    this.#handshake.reject(new Error('Runtime host closed before the handshake completed.'));
    // Closing twice is a normal path — a failed handshake releases the host,
    // and so does the caller that never got the handle — but the sessions
    // `onClose` tears down must only be released once.
    // Flush only — the sink is process-scoped and shared across reconnect /
    // supersede hosts. Closing it here would silence audit for every later
    // session. The CLI owns `audit.close()` at process end.
    void Promise.all([
      this.#audit?.flush() ?? Promise.resolve(),
      Promise.resolve(this.#onClose?.()),
    ]).then(
      () => completion.resolve(),
      (error: unknown) => completion.reject(error)
    );
    return this.#closePromise;
  }

  #receive(frame: RuntimeFrame): void {
    switch (frame.type) {
      case 'hello_ack':
        // A mismatch has to settle the handshake, not escape. This runs inside
        // the transport's frame listener — on a websocket that is the socket's
        // `message` event, where a throw lands nowhere the caller is looking,
        // and `waitUntilReady()` would sit until its timeout and report a
        // stalled hub instead of the version the hub actually speaks.
        try {
          assertRuntimeProtocolCompatible(frame.protocolVersion, this.#protocolVersion);
        } catch (error) {
          this.#handshake.reject(error instanceof Error ? error : new Error(String(error)));
          break;
        }
        this.#audit?.setHub(frame.hub ?? null);
        this.#ready = true;
        this.#handshake.resolve();
        break;
      case 'req':
        void this.#handleRequest(frame);
        break;
      case 'cancel':
        this.#activeRequests.get(frame.id)?.abort();
        break;
      case 'ping':
        this.#send({ type: 'pong' });
        break;
      case 'pong':
        for (const listener of [...this.#pongListeners]) listener();
        break;
      default:
        break;
    }
  }

  async #handleRequest(frame: RuntimeRequestFrame): Promise<void> {
    const started = performance.now();

    if (!this.#ready) {
      const err: RuntimeErrorPayload = {
        code: 'RUNTIME_UNAVAILABLE',
        message: 'Runtime handshake has not completed.',
      };
      this.#sendError(frame.id, err);
      this.#recordAudit(frame, 'error', started, err);
      return;
    }

    const handler = this.#handlers.get(frame.method);
    if (!handler) {
      const err: RuntimeErrorPayload = {
        code: 'METHOD_UNSUPPORTED',
        message: `Runtime method "${frame.method}" is not supported by this host.`,
        details: { method: frame.method },
      };
      this.#sendError(frame.id, err);
      this.#recordAudit(frame, 'error', started, err);
      return;
    }
    if (this.#activeRequests.has(frame.id)) {
      const err: RuntimeErrorPayload = {
        code: 'INTERNAL',
        message: `Runtime request id "${frame.id}" is already active.`,
      };
      this.#sendError(frame.id, err);
      this.#recordAudit(frame, 'error', started, err);
      return;
    }

    const updateMethod = frame.method.startsWith('runtime.update.');
    if (updateMethod && this.#activeRequests.size > 0) {
      const err = errorPayloadFor(
        new RuntimeUpdateError('Runtime update refused while another call is in flight.', {
          reason: 'call_in_flight',
        }),
        new AbortController().signal
      );
      this.#sendError(frame.id, err);
      this.#recordAudit(frame, 'error', started, err);
      return;
    }
    if (!updateMethod && (this.#activeUpdateRequests.size > 0 || this.#isUpdateActive())) {
      const err = errorPayloadFor(
        new RuntimeUpdateError('Runtime call refused while a binary update is in progress.', {
          reason: 'update_in_progress',
        }),
        new AbortController().signal
      );
      this.#sendError(frame.id, err);
      this.#recordAudit(frame, 'error', started, err);
      return;
    }

    const controller = new AbortController();
    this.#activeRequests.set(frame.id, controller);
    if (updateMethod) this.#activeUpdateRequests.add(frame.id);
    try {
      const result = await handler(frame.params, { signal: controller.signal });
      // Inside the try on purpose: a result the transport cannot frame — one
      // past the frame-size limit, say — becomes an error response for the
      // caller instead of a rejection nobody awaits.
      this.#send({ type: 'res', id: frame.id, ok: result });
      this.#recordAudit(frame, 'ok', started);
    } catch (error) {
      const err = errorPayloadFor(error, controller.signal);
      this.#sendError(frame.id, err);
      this.#recordAudit(frame, err.code === 'RUNTIME_DENIED' ? 'denied' : 'error', started, err);
    } finally {
      this.#activeRequests.delete(frame.id);
      this.#activeUpdateRequests.delete(frame.id);
    }
  }

  #recordAudit(
    frame: RuntimeRequestFrame,
    outcome: RuntimeAuditOutcome,
    started: number,
    err?: RuntimeErrorPayload
  ): void {
    const capability =
      err?.details && typeof err.details === 'object' && !Array.isArray(err.details)
        ? typeof (err.details as { capability?: unknown }).capability === 'string'
          ? (err.details as { capability: string }).capability
          : undefined
        : undefined;
    this.#audit?.record({
      method: frame.method,
      outcome,
      durationMs: performance.now() - started,
      params: frame.params,
      ...(capability ? { capability } : {}),
      ...(err?.code ? { code: err.code } : {}),
    });
  }

  #sendError(id: string, err: RuntimeErrorPayload): void {
    try {
      this.#send({ type: 'res', id, err });
    } catch {
      // The port is gone or the peer is closed; there is nobody left to notify.
    }
  }

  #send(frame: RuntimeFrame): void {
    // close() detaches the port while cancelled handlers may still be settling,
    // so a late frame has no destination and must not throw into a void call.
    this.#port?.send(frame);
  }
}

/**
 * A handshake promise nobody may have awaited yet. The rejection handler keeps
 * a close before the first `waitUntilReady()` from surfacing as an unhandled
 * rejection, and settling twice is a no-op.
 */
function deferredHandshake(): ReturnType<typeof Promise.withResolvers<void>> {
  const deferred = Promise.withResolvers<void>();
  deferred.promise.catch(() => undefined);
  return deferred;
}

function errorPayloadFor(error: unknown, signal: AbortSignal): RuntimeErrorPayload {
  if (signal.aborted || isAbortError(error)) {
    return {
      code: 'CANCELLED',
      message: error instanceof Error ? error.message : 'Runtime request was cancelled.',
    };
  }
  if (error instanceof RuntimeServiceError) {
    if (error.kind === 'consent_denied') {
      const missing = Array.isArray(error.data.missing)
        ? error.data.missing.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return {
        code: 'RUNTIME_DENIED',
        message: error.message,
        details: {
          kind: error.kind,
          ...error.data,
          capability:
            typeof error.data.capability === 'string' ? error.data.capability : missing[0],
        },
      };
    }
    if (error.kind === 'runtime_update_refused') {
      return {
        code: 'RUNTIME_UPDATE_REFUSED',
        message: error.message,
        details: { kind: error.kind, ...error.data },
      };
    }
    return {
      code: 'INTERNAL',
      message: error.message,
      details: { kind: error.kind, ...error.data },
    };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : 'Runtime method failed.',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
