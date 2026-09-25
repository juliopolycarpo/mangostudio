import { spawnPort } from '@mangostudio/protocol/spawn';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { resolveRuntimeLaunchCommand } from '../../../../../src/lib/runtime-paths';
import { RuntimeClient } from '../../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../../src/services/runtime-client/runtime-connection-manager';
import { spawnRuntimeChild } from '../../../../../src/services/runtime-client/spawn-runtime-child';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../../../support/rust-runtime-binary';

/**
 * The runtime `withTargetHome` spawns. Cases that use it skip where no binary
 * was built, which is the ordinary unit lane in CI.
 *
 * // Usage: it.skipIf(!targetHomeRuntime.available)('expands ~', async () => { ... });
 */
export const targetHomeRuntime = resolveRustRuntimeBinary();

/**
 * Runs `body` with the Local environment served by the Rust runtime binary,
 * spawned with `home` as its home directory.
 *
 * `~` is expanded from the capability manifest a runtime announced at connect,
 * not from the hub's environment, so moving the hub's `HOME` proves nothing
 * here. A runtime started with a different `HOME` announces that directory as
 * its `homeDir` — which is what a foreign target actually does — and then
 * reads and writes the paths the hub expanded against it. `MANGO_HOME` is a
 * scratch directory, so its slot files land neither in `home` nor in the
 * developer's own `~/.mango`.
 *
 * // Usage: await withTargetHome(tempDir, () => executeReadFile({ path: '~/f' }, ctx));
 */
export async function withTargetHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const binaryPath = targetHomeRuntime.path;
  const hubVersion = await rustRuntimeVersion(binaryPath);
  const mangoHome = await scratchMangoHome('target-home');
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: 'Local',
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: {
      'in-process': async (_definition, onUnavailable) => {
        const connection = await spawnRuntimeChild(
          {
            environmentId: LOCAL_ENVIRONMENT_ID,
            launch: resolveRuntimeLaunchCommand(undefined, {
              MANGOSTUDIO_RUNTIME_BINARY: binaryPath,
            }),
            workspaceBinding: null,
            hubVersion,
            onClosed: onUnavailable,
          },
          {
            spawnPort: (options) =>
              spawnPort({ ...options, env: { ...options.env, HOME: home, MANGO_HOME: mangoHome } }),
          }
        );
        return {
          client: new RuntimeClient(connection.hub, onUnavailable, LOCAL_ENVIRONMENT_ID),
          close: () => connection.close(),
        };
      },
    },
  });

  setRuntimeConnectionManagerForTests(manager);
  try {
    return await body();
  } finally {
    await manager.closeAll();
    setRuntimeConnectionManagerForTests(undefined);
    await cleanupMangoHome(mangoHome);
  }
}
