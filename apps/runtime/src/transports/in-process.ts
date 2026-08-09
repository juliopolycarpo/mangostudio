import { RuntimeProtocolClient } from '../client';
import { loadRuntimeConfig } from '../config';
import type { RuntimeHost } from '../host';
import { createInProcessPortPair } from '../transport';

export interface InProcessRuntimeConnection {
  readonly client: RuntimeProtocolClient;
  readonly host: RuntimeHost;
  close(): Promise<void>;
}

/** Connects the hub client and embedded runtime through the real frame path. */
export async function connectInProcessRuntime(
  host: RuntimeHost,
  options: {
    readonly hubVersion: string;
    readonly validateFrames?: boolean;
    readonly handshakeTimeoutMs?: number;
    readonly hub?: { readonly host: string; readonly user: string } | null;
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
    ...(options.hub !== undefined ? { hub: options.hub } : {}),
  });
  host.start();
  try {
    await Promise.all([client.waitUntilReady(), host.waitUntilReady()]);
  } catch (error) {
    // The caller only ever sees the rejection, so it cannot reach the handle to
    // release these; a failed handshake would otherwise leak a host and a port.
    client.close();
    await host.close();
    throw error;
  }

  return {
    client,
    host,
    async close() {
      client.close();
      await host.close();
    },
  };
}
