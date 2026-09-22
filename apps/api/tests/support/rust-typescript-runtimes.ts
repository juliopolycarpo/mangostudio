/**
 * The compiled Rust runtime and the in-process TypeScript runtime side by
 * side, for the differential `rust-*-compat` suites that send both the same
 * call and compare the answers.
 */

import { resolveRuntimeLaunchCommand } from '../../src/lib/runtime-paths';
import { connectLocalRuntime } from '../../src/services/runtime-client/connect-in-process-runtime';
import { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import { spawnRuntimeChild } from '../../src/services/runtime-client/spawn-runtime-child';
import { rustRuntimeVersion } from './rust-runtime-binary';

export interface RustAndTypeScriptRuntimes {
  readonly rust: RuntimeClient;
  readonly typescript: RuntimeClient;
  /** Closes both connections. */
  close(): Promise<void>;
}

function ignoreNotification(): void {
  /* No UI subscriber in these fixtures. */
}

/**
 * Spawns `binaryPath` over stdio and connects the in-process TypeScript
 * runtime, both authorizing every workspace, under the current `MANGO_HOME`.
 *
 * @example
 * const runtimes = await spawnRustAndTypeScriptRuntimes(binary.path, 'search-compat');
 * expect(await runtimes.rust.fs.glob(params)).toEqual(await runtimes.typescript.fs.glob(params));
 * await runtimes.close();
 */
export async function spawnRustAndTypeScriptRuntimes(
  binaryPath: string,
  label: string
): Promise<RustAndTypeScriptRuntimes> {
  const rustConnection = await spawnRuntimeChild({
    environmentId: `rust-${label}`,
    launch: resolveRuntimeLaunchCommand(undefined, { MANGOSTUDIO_RUNTIME_BINARY: binaryPath }),
    hubVersion: await rustRuntimeVersion(binaryPath),
    onClosed: ignoreNotification,
  });
  // Closed here if the TypeScript side fails to connect, since the caller
  // never receives a handle to it.
  const typescriptConnection = await connectLocalRuntime({
    authorizeWorkspace: () => true,
    externalAgentIsolation: 'withdrawn',
  }).catch(async (error: unknown) => {
    await rustConnection.close();
    throw error;
  });
  return {
    rust: new RuntimeClient(rustConnection.hub, ignoreNotification, `rust-${label}`),
    typescript: new RuntimeClient(
      typescriptConnection.hub,
      ignoreNotification,
      `typescript-${label}`
    ),
    close: async () => {
      await rustConnection.close();
      await typescriptConnection.close();
    },
  };
}
