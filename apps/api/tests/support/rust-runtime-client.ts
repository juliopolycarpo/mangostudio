/**
 * The compiled Rust runtime as a hub `RuntimeClient`, for the `rust-*-compat`
 * suites that assert its answers against expectations recorded from the
 * retired TypeScript runtime.
 */

import { resolveRuntimeLaunchCommand } from '../../src/lib/runtime-paths';
import { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import { spawnRuntimeChild } from '../../src/services/runtime-client/spawn-runtime-child';
import { rustRuntimeVersion } from './rust-runtime-binary';

export interface SpawnedRustRuntimeClient {
  readonly client: RuntimeClient;
  /** Closes the stdio connection and reaps the child. */
  close(): Promise<void>;
}

function ignoreNotification(): void {
  /* No UI subscriber in these fixtures. */
}

/**
 * Spawns `binaryPath` over stdio under the current `MANGO_HOME`, through the
 * production launch path, with no workspace binding.
 *
 * @example
 * const runtime = await spawnRustRuntimeClient(binary.path, 'search-compat');
 * expect(await runtime.client.fs.glob(params)).toEqual(recorded);
 * await runtime.close();
 */
export async function spawnRustRuntimeClient(
  binaryPath: string,
  label: string
): Promise<SpawnedRustRuntimeClient> {
  const connection = await spawnRuntimeChild({
    environmentId: `rust-${label}`,
    launch: resolveRuntimeLaunchCommand(undefined, { MANGOSTUDIO_RUNTIME_BINARY: binaryPath }),
    workspaceBinding: null,
    hubVersion: await rustRuntimeVersion(binaryPath),
    onClosed: ignoreNotification,
  });
  return {
    client: new RuntimeClient(connection.hub, ignoreNotification, `rust-${label}`),
    close: () => connection.close(),
  };
}
