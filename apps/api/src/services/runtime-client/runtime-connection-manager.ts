import { connectInProcessRuntime, createLocalRuntimeHost } from '@mangostudio/runtime';
import { getVersion } from '../../lib/config';
import { RuntimeClient } from './runtime-client';

let localClientPromise: Promise<RuntimeClient> | undefined;

/**
 * Returns the process-local runtime connection. Later environment routing can
 * replace this factory without changing tool executors.
 */
export function getRuntimeClient(): Promise<RuntimeClient> {
  localClientPromise ??= createLocalClient();
  return localClientPromise;
}

async function createLocalClient(): Promise<RuntimeClient> {
  const version = getVersion();
  const host = createLocalRuntimeHost({ runtimeVersion: version });
  const connection = await connectInProcessRuntime(host, { hubVersion: version });
  return new RuntimeClient(connection.client);
}
