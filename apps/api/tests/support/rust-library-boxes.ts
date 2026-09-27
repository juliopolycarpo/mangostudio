/**
 * Real `serve` runtimes with scratch homes, wired into the Hub the way
 * production reaches a remote machine — for suites that drive the Hub's
 * library writes over the protocol instead of an in-process engine.
 *
 * Each box is one compiled `mangostudio-runtime serve` rooted at its own
 * scratch `HOME`/`USERPROFILE` with every location override scrubbed, so the
 * Hub's `backupPolicyFor` roots the store at that home and no real agent home
 * is read or written. A fleet holds the Hub side: one user, one connection
 * manager, and any number of environment records. Two boxes may share one
 * home — two runtime processes on one machine, which is how Local plus an SSH
 * environment to the same host looks to the Hub.
 */

import { expect } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { PropagationApply, RemovalApply } from '@mangostudio/shared/library';
import type {
  RuntimeLibraryApplyParams,
  RuntimeLibraryRemoveParams,
} from '@mangostudio/shared/runtime-contract';
import { getDb } from '../../src/db/database';
import { setLibraryLocationDefaultsForTest } from '../../src/modules/app-settings/application/app-settings-service';
import { createEnvironmentService } from '../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../src/modules/environments/infrastructure/environment-repository';
import { backupPolicyFor } from '../../src/modules/library/infrastructure/backup-roots';
import { connectHttpRuntime } from '../../src/services/runtime-client/connect-http-runtime';
import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../src/services/runtime-client/runtime-token-secrets';
import { insertTestUser } from './factories';
import { InMemorySecretStore } from './mocks/mock-secret-store';
import { cleanupMangoHome, type RustRuntimeBinary, scratchMangoHome } from './rust-runtime-binary';
import { connectUntilListening, reserveEphemeralPort } from './rust-serve-dial';

/** Everything the runtime's location registry reads besides the home. */
const LOCATION_OVERRIDES = [
  'SKILLS_DIR',
  'AGENTS_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURSOR_CONFIG_DIR',
  'XDG_CONFIG_HOME',
];

/** One running `serve` binary and the scratch disk it owns. */
export interface LibraryBox {
  readonly home: string;
  readonly backupRoot: string;
  readonly baseUrl: string;
  readonly token: string;
}

export interface LibraryFleetUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** The Hub side of a set of boxes, plus teardown for all of it. */
export interface LibraryFleet {
  /**
   * Spawns a box and registers it under `environmentId`. With `sameHomeAs`,
   * the new runtime process roots at that box's home instead of a fresh one.
   */
  addBox(
    environmentId: string,
    options?: { readonly sameHomeAs?: LibraryBox }
  ): Promise<LibraryBox>;
  /** The Hub's live client for an environment, as production resolves it. */
  client(environmentId: string): Promise<RuntimeClient>;
  /** Enables the given home locations for every environment's scans. */
  enableHomeLocations(locationIds: readonly string[]): void;
  dispose(): Promise<void>;
}

/**
 * Opens a fleet for `user`. Call `dispose()` from `afterEach`.
 *
 * @example
 * const fleet = await openLibraryFleet(binary, USER);
 * const box = await fleet.addBox('box-a');
 * fleet.enableHomeLocations(['claude-skills', 'agents-skills']);
 * // … drive applyLibraryPropagation(USER.id, …) with environmentIds ['box-a']
 * await fleet.dispose();
 */
export async function openLibraryFleet(
  binary: RustRuntimeBinary,
  user: LibraryFleetUser
): Promise<LibraryFleet> {
  await insertTestUser(user);
  const store = new InMemorySecretStore();
  setRuntimeTokenStoreForTests(store);
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
    connectors: { http: connectHttpRuntime },
  });
  setRuntimeConnectionManagerForTests(manager);
  const service = createEnvironmentService(repository, manager, () => undefined, store);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const scratch: string[] = [];

  async function register(environmentId: string, box: LibraryBox): Promise<void> {
    await service.create(user.id, {
      id: environmentId,
      name: environmentId,
      transportKind: 'http',
      config: { baseUrl: box.baseUrl },
      token: box.token,
    });
    await connectUntilListening(() => service.connect(user.id, environmentId));
    const client = await manager.getClient(user.id, environmentId);
    expect({ environmentId, library: client.manifest.features.library }).toEqual({
      environmentId,
      library: true,
    });
    expect({ environmentId, homeDir: client.paths.homeDir }).toEqual({
      environmentId,
      homeDir: box.home,
    });
  }

  return {
    async addBox(environmentId, options = {}) {
      const prefix = `lib-${environmentId}`;
      const home =
        options.sameHomeAs?.home ?? realpathSync(await scratchMangoHome(`${prefix}-home`));
      const mangoHome = await scratchMangoHome(`${prefix}-slot`);
      if (!options.sameHomeAs) scratch.push(home);
      scratch.push(mangoHome);
      const token = `${prefix}-token`;
      const port = reserveEphemeralPort();
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MANGO_HOME: mangoHome,
        MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token,
      };
      for (const key of LOCATION_OVERRIDES) delete env[key];
      const child = Bun.spawn({
        cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
        env,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      children.push(child);
      const stderr = keepTail(child.stderr);
      const box: LibraryBox = {
        home,
        backupRoot: join(home, '.mango', 'library-backups'),
        baseUrl: `http://127.0.0.1:${port}`,
        token,
      };
      try {
        await register(environmentId, box);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `expected the serve runtime for "${environmentId}" to accept the hub | received ` +
            `${reason}; exit=${child.exitCode ?? 'still running'}; stderr=${JSON.stringify(stderr())}`,
          { cause: error }
        );
      }
      return box;
    },
    client: (environmentId) => manager.getClient(user.id, environmentId),
    enableHomeLocations(locationIds) {
      setLibraryLocationDefaultsForTest({
        home: Object.fromEntries(locationIds.map((id) => [id, true])),
        workspace: {},
      });
    },
    async dispose() {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
      setRuntimeConnectionManagerForTests(undefined);
      setRuntimeTokenStoreForTests(undefined);
      setLibraryLocationDefaultsForTest(null);
      for (const path of scratch) await cleanupMangoHome(path);
      await getDb().deleteFrom('activity_events').where('userId', '=', user.id).execute();
      await getDb().deleteFrom('library_backups').where('userId', '=', user.id).execute();
      await getDb().deleteFrom('environments').where('userId', '=', user.id).execute();
      await getDb().deleteFrom('user').where('id', '=', user.id).execute();
    },
  };
}

type Operation<P extends { readonly operations: readonly unknown[] }> = P['operations'][number];

/** Rewrites one operation of a write batch before it is sent; see `tamperingApply`. */
export type OperationTamper<O> = (operation: O, index: number, all: readonly O[]) => O;

/**
 * A `runtimeApply` seam that sends the Hub's own batch to the real runtime
 * after `tamper` rewrites its operations. Everything else — the envelope, the
 * backup policy resolved from the live connection, the wire, the runtime's
 * writes, verification and compensation — is the production path; only the
 * operation the test names is made to fail.
 *
 * @example
 * // The last destination fails verification after the earlier ones landed.
 * applyLibraryPropagation(userId, request, {
 *   runtimeApply: tamperingApply(fleet, (op, i, all) =>
 *     i === all.length - 1 ? { ...op, expectedContentHash: 'tampered' } : op),
 * });
 */
export function tamperingApply(
  fleet: LibraryFleet,
  tamper: OperationTamper<Operation<RuntimeLibraryApplyParams>>
): (params: RuntimeLibraryApplyParams) => Promise<PropagationApply> {
  return async (params) => {
    const environmentId = namedEnvironment(params.environmentId);
    const client = await fleet.client(environmentId);
    const policy = backupPolicyFor(client, environmentId);
    return await client.library.apply(
      {
        ...params,
        backupRoot: policy.backupRoot,
        retentionCount: policy.retentionCount,
        retentionBytes: policy.retentionBytes,
        operations: params.operations.map(tamper),
      },
      { timeoutMs: 60_000 }
    );
  };
}

/**
 * The removal counterpart of `tamperingApply`.
 *
 * @example
 * applyLibraryRemoval(userId, request, {
 *   runtimeRemove: tamperingRemove(fleet, (op, i) =>
 *     i === 1 ? { ...op, expectedContentHash: 'tampered' } : op),
 * });
 */
export function tamperingRemove(
  fleet: LibraryFleet,
  tamper: OperationTamper<Operation<RuntimeLibraryRemoveParams>>
): (params: RuntimeLibraryRemoveParams) => Promise<RemovalApply> {
  return async (params) => {
    const environmentId = namedEnvironment(params.environmentId);
    const client = await fleet.client(environmentId);
    const policy = backupPolicyFor(client, environmentId);
    return await client.library.remove(
      {
        ...params,
        backupRoot: policy.backupRoot,
        retentionCount: policy.retentionCount,
        retentionBytes: policy.retentionBytes,
        operations: params.operations.map(tamper),
      },
      { timeoutMs: 60_000 }
    );
  };
}

/** The Hub always names the machine a batch is for; a batch without one is a Hub regression. */
function namedEnvironment(environmentId: string | undefined): string {
  if (environmentId === undefined) {
    throw new Error('expected a write batch naming its environmentId | received none');
  }
  return environmentId;
}

/**
 * Drains a child stream and keeps its last `limit` characters, so a startup failure can quote what
 * the runtime printed without the pipe ever filling up.
 *
 * @example
 * const stderr = keepTail(child.stderr);
 * throw new Error(`serve failed: ${stderr()}`);
 */
function keepTail(stream: ReadableStream<Uint8Array>, limit = 4_000): () => string {
  let tail = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-limit);
    }
  })().catch(() => undefined);
  return () => tail;
}
