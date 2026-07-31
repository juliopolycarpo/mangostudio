import {
  assertRuntimeProtocolCompatible,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCapabilityManifest,
  type RuntimeErrorPayload,
  type RuntimeFrame,
  type RuntimeProtocolVersion,
  type RuntimeRequestFrame,
} from '@mangostudio/shared/runtime-protocol';
import { RuntimeServiceError } from './errors';
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
  readonly manifest: RuntimeCapabilityManifest;
  readonly handlers: ReadonlyMap<string, RuntimeMethodHandler>;
  readonly protocolVersion?: RuntimeProtocolVersion;
}

/** Dispatches protocol requests and owns the cancellation controller per call. */
export class RuntimeHost {
  readonly #activeRequests = new Map<string, AbortController>();
  readonly #handlers: ReadonlyMap<string, RuntimeMethodHandler>;
  readonly #manifest: RuntimeCapabilityManifest;
  readonly #protocolVersion: RuntimeProtocolVersion;
  readonly #runtimeVersion: string;
  #detach?: () => void;
  #port?: RuntimeFramePort;
  #ready = false;

  constructor(options: RuntimeHostOptions) {
    this.#runtimeVersion = options.runtimeVersion;
    this.#manifest = options.manifest;
    this.#handlers = options.handlers;
    this.#protocolVersion = options.protocolVersion ?? RUNTIME_PROTOCOL_VERSION;
  }

  attach(port: RuntimeFramePort): void {
    this.#detach?.();
    this.#port = port;
    this.#detach = port.onFrame((frame) => this.#receive(frame));
  }

  start(): void {
    this.#send({
      type: 'hello',
      protocolVersion: this.#protocolVersion,
      runtimeVersion: this.#runtimeVersion,
      manifest: this.#manifest,
    });
  }

  close(): void {
    this.#detach?.();
    this.#detach = undefined;
    for (const controller of this.#activeRequests.values()) controller.abort();
    this.#activeRequests.clear();
    this.#port?.close();
    this.#port = undefined;
    this.#ready = false;
  }

  #receive(frame: RuntimeFrame): void {
    switch (frame.type) {
      case 'hello_ack':
        assertRuntimeProtocolCompatible(frame.protocolVersion, this.#protocolVersion);
        this.#ready = true;
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
      default:
        break;
    }
  }

  async #handleRequest(frame: RuntimeRequestFrame): Promise<void> {
    if (!this.#ready) {
      this.#sendError(frame.id, {
        code: 'RUNTIME_UNAVAILABLE',
        message: 'Runtime handshake has not completed.',
      });
      return;
    }

    const handler = this.#handlers.get(frame.method);
    if (!handler) {
      this.#sendError(frame.id, {
        code: 'METHOD_UNSUPPORTED',
        message: `Runtime method "${frame.method}" is not supported by this host.`,
        details: { method: frame.method },
      });
      return;
    }
    if (this.#activeRequests.has(frame.id)) {
      this.#sendError(frame.id, {
        code: 'INTERNAL',
        message: `Runtime request id "${frame.id}" is already active.`,
      });
      return;
    }

    const controller = new AbortController();
    this.#activeRequests.set(frame.id, controller);
    try {
      const result = await handler(frame.params, { signal: controller.signal });
      this.#send({ type: 'res', id: frame.id, ok: result });
    } catch (error) {
      this.#sendError(frame.id, errorPayloadFor(error, controller.signal));
    } finally {
      this.#activeRequests.delete(frame.id);
    }
  }

  #sendError(id: string, err: RuntimeErrorPayload): void {
    this.#send({ type: 'res', id, err });
  }

  #send(frame: RuntimeFrame): void {
    if (!this.#port) throw new Error('Runtime host is not attached to a transport.');
    this.#port.send(frame);
  }
}

function errorPayloadFor(error: unknown, signal: AbortSignal): RuntimeErrorPayload {
  if (signal.aborted || isAbortError(error)) {
    return {
      code: 'CANCELLED',
      message: error instanceof Error ? error.message : 'Runtime request was cancelled.',
    };
  }
  if (error instanceof RuntimeServiceError) {
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
