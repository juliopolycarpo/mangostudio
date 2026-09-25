import { spawnPort } from '@mangostudio/protocol/spawn';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { RuntimeMethod } from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { resolveRuntimeLaunchCommand } from '../../../../../src/lib/runtime-paths';
import { RuntimeClient } from '../../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../../src/services/runtime-client/runtime-connection-manager';
import { spawnRuntimeChild } from '../../../../../src/services/runtime-client/spawn-runtime-child';
import {
  connectFakeRuntime,
  FakeRuntimeDefinition,
  fixedConsent,
  type TestHandler,
} from '../../../../support/fake-runtime-host';
import { TEST_RUNTIME_MANIFEST } from '../../../../support/runtime-fixture';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
  skipWithoutRustBinary,
} from '../../../../support/rust-runtime-binary';

/**
 * The runtime `withTargetHome` spawns. Cases that use it skip where no binary
 * was built, which is the ordinary unit lane in CI.
 *
 * // Usage: it.skipIf(!targetHomeRuntime.available)('expands ~', async () => { ... });
 */
export const targetHomeRuntime = resolveRustRuntimeBinary();

export { skipWithoutRustBinary };

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
              // The runtime resolves its home from HOME on POSIX and
              // USERPROFILE on Windows, so both name the case directory.
              spawnPort({
                ...options,
                env: { ...options.env, HOME: home, USERPROFILE: home, MANGO_HOME: mangoHome },
              }),
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

/**
 * Runs `body` with the Local environment served by the fake host, announcing
 * `home` (a POSIX path; nothing reads it) as its home directory. The hub's own
 * half of `~` — expanding against the announced manifest rather than its own
 * environment — is then visible in what `handlers` receive, in the ordinary
 * lane where no Rust binary is built.
 *
 * // Usage: await withFakeTargetHome('/target/home', { 'fs.read-file': record }, () => run());
 */
export async function withFakeTargetHome<T>(
  home: string,
  handlers: Partial<Record<RuntimeMethod, TestHandler>>,
  body: () => Promise<T>
): Promise<T> {
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
        const definition = new FakeRuntimeDefinition({
          runtimeVersion: 'target-home',
          manifest: { ...TEST_RUNTIME_MANIFEST, homeDir: home, enforcesPathPolicy: true },
          consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
          handlers,
        });
        const connection = await connectFakeRuntime(definition, { hubVersion: 'target-home' });
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
  }
}
