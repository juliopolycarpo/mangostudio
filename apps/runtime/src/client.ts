import {
  assertRuntimeProtocolCompatible,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCapabilityManifest,
  type RuntimeEventFrame,
  type RuntimeFrame,
  type RuntimeHelloFrame,
  RuntimeProtocolError,
  type RuntimeProtocolVersion,
  type RuntimeResponseFrame,
} from '@mangostudio/shared/runtime-protocol';
import { RuntimeRemoteError } from './errors';
import type { RuntimeMethod, RuntimeMethodMap } from './methods';
import type { RuntimeFramePort } from './transport';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export interface RuntimeRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RuntimeProtocolClientOptions {
  readonly hubVersion: string;
  readonly protocolVersion?: RuntimeProtocolVersion;
  readonly handshakeTimeoutMs?: number;
  /**
   * Refuse a runtime whose release version differs from the hub's. Set by the
   * transports where the two ship as one distribution and are meant to travel
   * together, so a leftover binary from an older install is rejected instead of
   * being trusted for method semantics it may no longer share. The protocol
   * version alone cannot catch that: it only changes when the wire format does.
   */
  readonly requireMatchingRelease?: boolean;
}

/** Hub-side request multiplexer for any runtime frame transport. */
export class RuntimeProtocolClient {
  readonly #eventListeners = new Set<(event: RuntimeEventFrame) => void>();
  readonly #pongListeners = new Set<() => void>();
  /** Fires once when {@link close} runs; used to drop hub-side session handles. */
  readonly #closeListeners = new Set<() => void>();
  readonly #hubVersion: string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #port: RuntimeFramePort;
  readonly #protocolVersion: RuntimeProtocolVersion;
  readonly #ready: Promise<void>;
  readonly #requireMatchingRelease: boolean;
  #closed = false;
  #detach: () => void;
  #handshakeTimer?: ReturnType<typeof setTimeout>;
  #rejectReady: (error: Error) => void = () => undefined;
  #requestSequence = 0;
  #resolveReady: () => void = () => undefined;
  #runtimeManifest?: RuntimeCapabilityManifest;
  #runtimeVersion?: string;

  constructor(port: RuntimeFramePort, options: RuntimeProtocolClientOptions) {
    this.#port = port;
    this.#hubVersion = options.hubVersion;
    this.#protocolVersion = options.protocolVersion ?? RUNTIME_PROTOCOL_VERSION;
    this.#requireMatchingRelease = options.requireMatchingRelease ?? false;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // The handshake can fail before anyone awaits waitUntilReady(); without a
    // subscriber the rejection would surface as an unhandled rejection.
    this.#ready.catch(() => undefined);
    this.#detach = port.onFrame((frame) => this.#receive(frame));
    this.#handshakeTimer = setTimeout(() => {
      this.#rejectReady(
        new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Runtime handshake timed out.')
      );
    }, options.handshakeTimeoutMs ?? 5_000);
  }

  get manifest(): RuntimeCapabilityManifest {
    if (!this.#runtimeManifest) throw new Error('Runtime handshake has not completed.');
    return this.#runtimeManifest;
  }

  get runtimeVersion(): string {
    if (!this.#runtimeVersion) throw new Error('Runtime handshake has not completed.');
    return this.#runtimeVersion;
  }

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  async request<K extends RuntimeMethod>(
    method: K,
    params: RuntimeMethodMap[K]['params'],
    options: RuntimeRequestOptions = {}
  ): Promise<RuntimeMethodMap[K]['result']> {
    await this.#ready;
    // Awaiting #ready yields, so close() can land between the call and here.
    // Without this the send below throws a bare transport error instead of the
    // protocol error every caller already handles.
    if (this.#closed) {
      throw new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Runtime connection was closed.');
    }
    const id = `runtime-${++this.#requestSequence}`;

    return await new Promise<RuntimeMethodMap[K]['result']>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const abort = () => this.#port.send({ type: 'cancel', id });
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      };
      this.#pending.set(id, {
        resolve: (value) => resolve(value as RuntimeMethodMap[K]['result']),
        reject,
        cleanup,
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          pending.cleanup();
          this.#port.send({ type: 'cancel', id });
          reject(
            new RuntimeRemoteError(
              'TIMEOUT',
              `Runtime method "${method}" timed out after ${options.timeoutMs}ms.`
            )
          );
        }, options.timeoutMs);
      }

      this.#port.send({ type: 'req', id, method, params });
      if (options.signal?.aborted) abort();
    });
  }

  onEvent(listener: (event: RuntimeEventFrame) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /**
   * Subscribes to connection teardown. Unlike `onEvent`, this fires when the
   * hub closes the transport — event listeners are cleared without a farewell
   * frame, so MCP handles that only watch `evt` would otherwise keep a dead
   * session until the next failed call.
   */
  onClose(listener: () => void): () => void {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** Sends a protocol ping. The runtime answers with `pong`. */
  ping(): void {
    this.#port.send({ type: 'ping' });
  }

  onPong(listener: () => void): () => void {
    this.#pongListeners.add(listener);
    return () => this.#pongListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#handshakeTimer);
    this.#detach();
    // Settling #ready is what unblocks a waitUntilReady() or a request() that
    // is still parked on the handshake; on an already-settled promise this is a
    // no-op.
    this.#rejectReady(
      new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Runtime connection was closed.')
    );
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(
        new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Runtime connection was closed.')
      );
    }
    this.#pending.clear();
    this.#eventListeners.clear();
    this.#pongListeners.clear();
    const closeListeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    for (const listener of closeListeners) listener();
    this.#port.close();
  }

  #receive(frame: RuntimeFrame): void {
    switch (frame.type) {
      case 'hello':
        this.#completeHandshake(frame);
        break;
      case 'res':
        this.#completeRequest(frame);
        break;
      case 'evt':
        for (const listener of [...this.#eventListeners]) listener(frame);
        break;
      // Liveness is symmetric: each side pings on its own cadence and answers
      // the other's, so a quiet-but-healthy socket proves itself in both
      // directions rather than only where traffic happens to flow.
      case 'ping':
        this.#port.send({ type: 'pong' });
        break;
      case 'pong':
        for (const listener of [...this.#pongListeners]) listener();
        break;
      default:
        break;
    }
  }

  #completeHandshake(frame: RuntimeHelloFrame): void {
    try {
      assertRuntimeProtocolCompatible(this.#protocolVersion, frame.protocolVersion);
      if (this.#requireMatchingRelease && frame.runtimeVersion !== this.#hubVersion) {
        throw new RuntimeProtocolError(
          'PROTOCOL_MISMATCH',
          `Runtime ${frame.runtimeVersion} does not match hub ${this.#hubVersion}. ` +
            'Reinstall MangoStudio so the hub and runtime come from the same release.',
          { hubVersion: this.#hubVersion, runtimeVersion: frame.runtimeVersion }
        );
      }
      this.#runtimeManifest = frame.manifest;
      this.#runtimeVersion = frame.runtimeVersion;
      this.#port.send({
        type: 'hello_ack',
        protocolVersion: this.#protocolVersion,
        hubVersion: this.#hubVersion,
      });
      clearTimeout(this.#handshakeTimer);
      this.#resolveReady();
    } catch (error) {
      clearTimeout(this.#handshakeTimer);
      this.#rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #completeRequest(frame: RuntimeResponseFrame): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    pending.cleanup();
    if ('ok' in frame) {
      pending.resolve(frame.ok);
      return;
    }
    pending.reject(new RuntimeRemoteError(frame.err.code, frame.err.message, frame.err.details));
  }
}
