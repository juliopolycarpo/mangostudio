import {
  connectInProcessRuntime,
  createLocalRuntimeManifest,
  createRuntimeMethodHandlers,
  RuntimeHost,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { RuntimeClient } from '../../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../../src/services/runtime-client/runtime-connection-manager';

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
        let host: RuntimeHost | undefined;
        const registry = createRuntimeMethodHandlers({
          runtimeVersion: VERSION,
          emit: (event) => host?.emit(event),
        });
        host = new RuntimeHost({
          runtimeVersion: VERSION,
          manifest: { ...createLocalRuntimeManifest(), homeDir: home },
          handlers: registry.handlers,
          onClose: () => void registry.close(),
        });
        const connection = await connectInProcessRuntime(host, { hubVersion: VERSION });
        return {
          client: new RuntimeClient(connection.client, onUnavailable),
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
