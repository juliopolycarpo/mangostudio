import { RuntimeProtocolClient } from '../client';
import { loadRuntimeConfig } from '../config';
import type { RuntimeHost } from '../host';
import { createInProcessPortPair } from '../transport';

export interface InProcessRuntimeConnection {
  readonly client: RuntimeProtocolClient;
  readonly host: RuntimeHost;
  close(): void;
}

/** Connects the hub client and embedded runtime through the real frame path. */
export async function connectInProcessRuntime(
  host: RuntimeHost,
  options: {
    readonly hubVersion: string;
    readonly validateFrames?: boolean;
    readonly handshakeTimeoutMs?: number;
  }
): Promise<InProcessRuntimeConnection> {
  const validateFrames = options.validateFrames ?? loadRuntimeConfig().validateInProcessFrames;
  const ports = createInProcessPortPair({ validateFrames });
  host.attach(ports.runtime);
  const client = new RuntimeProtocolClient(ports.hub, {
    hubVersion: options.hubVersion,
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  });
  host.start();
  await client.waitUntilReady();

  return {
    client,
    host,
    close() {
      client.close();
      host.close();
    },
  };
}
