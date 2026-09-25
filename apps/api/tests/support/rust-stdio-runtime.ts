/**
 * One compiled `mangostudio-runtime --stdio` child under a scratch
 * `MANGO_HOME`, joined to a real hub session — for tests that need real
 * runtime behaviour (a PTY, the library engine) rather than a fake host.
 *
 * The child's environment is the SDK's sanitized parent environment plus the
 * scratch home, set on the child alone: the test process's own `MANGO_HOME`
 * is never touched, so nothing leaks into the next file in the same run.
 */

import { sanitizedEnv, spawnPort } from '@mangostudio/protocol/spawn';
import type { HubExternalAgentIsolation } from '@mangostudio/shared/runtime-contract';
import { openHubSession } from '../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import { cleanupMangoHome, rustRuntimeVersion, scratchMangoHome } from './rust-runtime-binary';

export interface RustStdioRuntime {
  readonly client: RuntimeClient;
  /** The scratch `MANGO_HOME` the child runs under; removed by {@link close}. */
  readonly mangoHome: string;
  /** Ends the session, waits for the child to exit, and removes the scratch home. */
  close(): Promise<void>;
}

export interface SpawnRustStdioRuntimeOptions {
  /** Names the scratch home and the client, so a failure says which test spawned it. */
  readonly label: string;
  readonly externalAgentIsolation?: HubExternalAgentIsolation;
}

/**
 * Spawns `binaryPath` over stdio and opens a hub session with it. The child
 * resolves the `host` slot, whose unanswered default is a full grant.
 *
 * @example
 * const runtime = await spawnRustStdioRuntime(binary.path, { label: 'terminal-socket' });
 * try { await runtime.client.health(); } finally { await runtime.close(); }
 */
export async function spawnRustStdioRuntime(
  binaryPath: string,
  options: SpawnRustStdioRuntimeOptions
): Promise<RustStdioRuntime> {
  const mangoHome = await scratchMangoHome(options.label);
  const peer = spawnPort({
    argv: [binaryPath, '--stdio'],
    env: sanitizedEnv(process.env, { MANGO_HOME: mangoHome }),
    terminateGraceMs: 2_000,
    killGraceMs: 2_000,
    exitGraceMs: 1_000,
  });
  try {
    const hub = await openHubSession(peer.port, {
      workspaceBinding: null,
      hubVersion: await rustRuntimeVersion(binaryPath),
      ...(options.externalAgentIsolation
        ? { externalAgentIsolation: options.externalAgentIsolation }
        : {}),
    });
    return {
      client: new RuntimeClient(hub, () => undefined, options.label),
      mangoHome,
      async close() {
        hub.close();
        await peer.terminate();
        await cleanupMangoHome(mangoHome);
      },
    };
  } catch (error) {
    await peer.terminate();
    await cleanupMangoHome(mangoHome);
    throw error;
  }
}
