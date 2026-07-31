import {
  assertRuntimeProtocolCompatible,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCapabilityManifest,
  type RuntimeEventFrame,
  type RuntimeFrame,
  type RuntimeHelloFrame,
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
}

/** Hub-side request multiplexer for any runtime frame transport. */
export class RuntimeProtocolClient {
  readonly #eventListeners = new Set<(event: RuntimeEventFrame) => void>();
  readonly #hubVersion: string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #port: RuntimeFramePort;
  readonly #protocolVersion: RuntimeProtocolVersion;
  readonly #ready: Promise<void>;
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
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
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

  close(): void {
    clearTimeout(this.#handshakeTimer);
    this.#detach();
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(
        new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Runtime connection was closed.')
      );
    }
    this.#pending.clear();
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
        for (const listener of this.#eventListeners) listener(frame);
        break;
      default:
        break;
    }
  }

  #completeHandshake(frame: RuntimeHelloFrame): void {
    try {
      assertRuntimeProtocolCompatible(this.#protocolVersion, frame.protocolVersion);
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
