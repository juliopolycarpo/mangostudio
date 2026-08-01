/**
 * Hub dial-out to a Direct URL runtime (`transportKind: 'http'`).
 *
 * The runtime listens with `mangostudio-runtime serve`; the hub opens a
 * WebSocket with the stored bearer token and speaks the same chunked framing
 * as the paired dial-in path. Release equality is not a gate — the binary on
 * that machine is not part of this hub's distribution.
 */

import {
  clientWebSocketSink,
  createWebSocketFramePort,
  livenessIntervalFor,
  RuntimeProtocolClient,
  RuntimeRemoteError,
  startProtocolLiveness,
} from '@mangostudio/runtime';
import { REALTIME_IDLE_TIMEOUT_SECONDS } from '@mangostudio/shared/realtime';
import { RUNTIME_CLOSE_CODES, RuntimeProtocolError } from '@mangostudio/shared/runtime-protocol';
import { getVersion } from '../../lib/config';
import { createDiagnosticLogger } from '../../lib/logger';
import { environmentConfigFor } from '../../modules/environments/domain/environment-config';
import { httpRuntimeBaseUrlToWebSocketUrl } from './http-runtime-url';
import { RuntimeClient } from './runtime-client';
import { readRuntimeToken } from './runtime-token-secrets';

const HANDSHAKE_TIMEOUT_MS = 15_000;

const logger = createDiagnosticLogger('runtime-http');

/** Minimal definition shape — kept local to avoid a cycle with the manager. */
export interface HttpRuntimeDefinition {
  readonly id: string;
  readonly userId: string;
  readonly config: unknown;
}

export interface HttpRuntimeConnection {
  readonly client: RuntimeClient;
  close(reason?: 'released' | 'superseded'): void | Promise<void>;
}

export async function connectHttpRuntime(
  definition: HttpRuntimeDefinition,
  onUnavailable: () => void
): Promise<HttpRuntimeConnection> {
  const { baseUrl } = environmentConfigFor('http', definition.config);
  const wsUrl = httpRuntimeBaseUrlToWebSocketUrl(baseUrl);
  const token = await readRuntimeToken(definition.userId, definition.id);

  // Bun accepts an options object with headers; the DOM `WebSocket` typings in
  // this workspace only list the protocol-array overload, so the cast is local.
  const socket = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  } as unknown as string[]);
  socket.binaryType = 'arraybuffer';

  let notified = false;
  const notifyGone = (): void => {
    if (notified) return;
    notified = true;
    onUnavailable();
  };

  const port = createWebSocketFramePort({
    sink: clientWebSocketSink({
      send: (message) => {
        socket.send(message as Uint8Array<ArrayBuffer>);
      },
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    }),
    onClosed: (closure) => {
      if (closure.kind === 'protocol-error') {
        logger.error('frame_rejected', {
          environmentId: definition.id,
          error: closure.error.message,
        });
      }
      notifyGone();
    },
  });

  socket.addEventListener('message', (event) => port.receive(event.data as ArrayBuffer));
  socket.addEventListener('close', () => {
    port.handleSocketClosed();
    notifyGone();
  });

  // Subscribe before the upgrade completes: the runtime starts its host in
  // `open` and the hello can race a listener attached only after `open` fires.
  const client = new RuntimeProtocolClient(port, {
    hubVersion: getVersion(),
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    requireMatchingRelease: false,
  });

  const opened = await Promise.race([
    new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true), { once: true });
      socket.addEventListener('close', () => resolve(false), { once: true });
      socket.addEventListener('error', () => resolve(false), { once: true });
    }),
    sleepMs(HANDSHAKE_TIMEOUT_MS).then(() => false),
  ]);
  if (!opened) {
    notified = true;
    client.close();
    try {
      socket.close(1000, 'Handshake timed out');
    } catch {
      // Already closed.
    }
    throw new RuntimeRemoteError(
      'RUNTIME_UNAVAILABLE',
      `Environment "${definition.id}" did not accept a WebSocket at ${baseUrl}.`
    );
  }

  try {
    await client.waitUntilReady();
  } catch (error) {
    notified = true;
    socket.close(1000, 'Handshake failed');
    client.close();
    throw asConnectError(error);
  }

  // The listening runtime disables Bun's idle timeout; hub-side protocol
  // pings are what notice a frozen peer and drop the cached connection.
  const stopLiveness = startProtocolLiveness({
    ping: () => client.ping(),
    onPong: (listener) => client.onPong(listener),
    intervalMs: livenessIntervalFor(REALTIME_IDLE_TIMEOUT_SECONDS),
    onTimeout: () => {
      logger.warn('liveness_timeout', { environmentId: definition.id });
      try {
        socket.close(RUNTIME_CLOSE_CODES.RELEASED, 'Liveness timeout');
      } catch {
        // Already closed.
      }
    },
  });

  return {
    client: new RuntimeClient(client, notifyGone),
    close(reason) {
      notified = true;
      stopLiveness();
      client.close();
      try {
        socket.close(
          reason === 'superseded' ? RUNTIME_CLOSE_CODES.SUPERSEDED : RUNTIME_CLOSE_CODES.RELEASED,
          reason === 'superseded' ? 'Superseded' : 'Released'
        );
      } catch {
        // Already closed.
      }
    },
  };
}

function asConnectError(error: unknown): RuntimeRemoteError {
  if (error instanceof RuntimeRemoteError) return error;
  if (error instanceof RuntimeProtocolError) {
    return new RuntimeRemoteError(error.code, error.message, error.details);
  }
  return new RuntimeRemoteError(
    'RUNTIME_UNAVAILABLE',
    error instanceof Error ? error.message : String(error)
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
