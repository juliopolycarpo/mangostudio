/**
 * The narrow slice of `RuntimeClient` this module depends on.
 *
 * A structural subset rather than the concrete class, so a `FakeRuntimeClient`
 * in tests can stand in for it without extending or mocking the real facade —
 * `RuntimeClient` itself satisfies this shape.
 */

import type {
  RuntimeCapabilityManifest,
  RuntimeRequestOptions,
  RuntimeTerminalAckParams,
  RuntimeTerminalAttachParams,
  RuntimeTerminalAttachResult,
  RuntimeTerminalCloseParams,
  RuntimeTerminalDetachParams,
  RuntimeTerminalListResult,
  RuntimeTerminalOpenParams,
  RuntimeTerminalOpenResult,
  RuntimeTerminalOutputEvent,
  RuntimeTerminalResizeParams,
  RuntimeTerminalWriteParams,
} from '@mangostudio/runtime';

export interface TerminalRuntimeTerminalClient {
  open(
    params: RuntimeTerminalOpenParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeTerminalOpenResult>;
  attach(
    params: RuntimeTerminalAttachParams,
    options?: RuntimeRequestOptions
  ): Promise<RuntimeTerminalAttachResult>;
  detach(
    params: RuntimeTerminalDetachParams,
    options?: RuntimeRequestOptions
  ): Promise<{ readonly ok: true }>;
  write(
    params: RuntimeTerminalWriteParams,
    options?: RuntimeRequestOptions
  ): Promise<{ readonly ok: true }>;
  resize(
    params: RuntimeTerminalResizeParams,
    options?: RuntimeRequestOptions
  ): Promise<{ readonly ok: true }>;
  ack(
    params: RuntimeTerminalAckParams,
    options?: RuntimeRequestOptions
  ): Promise<{ readonly ok: true }>;
  close(
    params: RuntimeTerminalCloseParams,
    options?: RuntimeRequestOptions
  ): Promise<{ readonly ok: true }>;
  list(options?: RuntimeRequestOptions): Promise<RuntimeTerminalListResult>;
  onOutput(sessionId: string, listener: (event: RuntimeTerminalOutputEvent) => void): () => void;
}

export interface TerminalRuntimeClient {
  readonly manifest: RuntimeCapabilityManifest;
  readonly terminal: TerminalRuntimeTerminalClient;
  /** Fires once, when the underlying connection to this environment ends. */
  onClose(listener: () => void): () => void;
}
