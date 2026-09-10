import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { connectInProcessRuntime } from '../../../../../src/services/runtime-client/connect-in-process-runtime';
import { RuntimeClient } from '../../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../../src/services/runtime-client/runtime-connection-manager';
import { createLocalRuntimeDefinition } from '../../../../support/local-runtime';

const VERSION = 'test';

/**
 * Runs `body` against a Local runtime that reports `home` as its home directory.
 *
 * `~` is expanded from the capability manifest a runtime announced at connect,
 * not from the hub's environment, so moving `HOME` proves nothing here — and
 * `os.homedir()` would not follow it mid-process anyway. Overriding the
 * manifest is what a foreign target actually does.
 *
 * // Usage: await withTargetHome(tempDir, () => executeReadFile({ path: '~/f' }, ctx));
 */
export async function withTargetHome<T>(home: string, body: () => Promise<T>): Promise<T> {
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
        const definition = createLocalRuntimeDefinition({
          runtimeVersion: VERSION,
          reshapeManifest: (manifest) => ({ ...manifest, homeDir: home }),
        });
        const connection = await connectInProcessRuntime(definition, { hubVersion: VERSION });
        return {
          client: new RuntimeClient(connection.hub, onUnavailable),
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
