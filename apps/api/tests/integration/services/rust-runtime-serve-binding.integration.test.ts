/**
 * Two environment records pointing at one real `mangostudio-runtime serve`.
 *
 * `serve` holds exactly one hub connection. Before binding keys, the second
 * record's connect superseded the first, whose next caller superseded the
 * second back — each record taking the other offline for as long as both were
 * used. The hub now sends a binding key derived from the environment record
 * in its upgrade request, and the runtime refuses a connection for a different
 * record while a live one holds it, before either side's `hello`. This drives
 * that through the real binary and the real connection manager: the first record stays connected, the second reports
 * `boundElsewhere`, and nothing redials fast enough to flap.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { EnvironmentConnectionState } from '@mangostudio/shared/environments';
import { RUNTIME_ALREADY_BOUND_CLOSE_CODE } from '@mangostudio/shared/runtime-contract';
import { getDb } from '../../../src/db/database';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../../src/services/runtime-client/runtime-token-secrets';
import { insertTestUser } from '../../support/factories';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import { waitUntil } from '../../support/rust-runtime-install-fixture';
import { connectUntilListening, reserveEphemeralPort } from '../../support/rust-serve-dial';

const binary = resolveRustRuntimeBinary();

const TEST_USER = {
  id: 'rust-serve-binding-user',
  name: 'Rust Serve Binding User',
  email: 'rust-serve-binding@mangostudio.test',
};

const OWNER = 'rust-serve-owner';
const DUPLICATE = 'rust-serve-duplicate';

/** Lazy callers the duplicate record sees inside the observation window. */
const LAZY_CALLERS = 5;

/** Everything the child writes to stderr, as it arrives. */
function collectStderr(stream: ReadableStream<Uint8Array>): { text(): string } {
  let collected = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) collected += decoder.decode(chunk, { stream: true });
  })();
  return { text: () => collected };
}

function countLines(text: string, needle: string): number {
  return text.split('\n').filter((line) => line.includes(needle)).length;
}

describe('Real Rust serve runtime shared by two environment records', () => {
  let mangoHome: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;

  afterEach(async () => {
    if (child) {
      child.kill();
      await child.exited;
      child = undefined;
    }
    setRuntimeConnectionManagerForTests(undefined);
    setRuntimeTokenStoreForTests(undefined);
    if (mangoHome) await cleanupMangoHome(mangoHome);
    mangoHome = undefined;
    await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
    await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
  });

  it.skipIf(!binary.available)(
    'keeps the first record connected and reports the second as bound elsewhere, without flapping',
    async () => {
      await insertTestUser(TEST_USER);
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      const token = 'rust-serve-binding-token';
      mangoHome = await scratchMangoHome('serve-binding');
      const port = reserveEphemeralPort();

      const spawned = Bun.spawn({
        cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
        env: { ...process.env, MANGO_HOME: mangoHome, MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token },
        stdout: 'ignore',
        stderr: 'pipe',
      });
      child = spawned;
      const stderr = collectStderr(spawned.stderr);

      const repository = createEnvironmentRepository(getDb());
      const ownerStates: EnvironmentConnectionState[] = [];
      const manager: RuntimeConnectionManager = new RuntimeConnectionManager({
        resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
        connectors: { http: connectHttpRuntime },
        publish: () => {
          ownerStates.push(manager.getStatus(TEST_USER.id, OWNER).state);
        },
        recordTransition: () => undefined,
      });
      setRuntimeConnectionManagerForTests(manager);
      const service = createEnvironmentService(repository, manager, () => undefined, store);

      for (const id of [OWNER, DUPLICATE]) {
        await service.create(TEST_USER.id, {
          id,
          name: id,
          transportKind: 'http',
          config: { baseUrl: `http://127.0.0.1:${port}` },
          token,
        });
      }

      const owner = await connectUntilListening(() => service.connect(TEST_USER.id, OWNER));
      expect(owner.status.state).toBe('connected');
      const ownerClient = await manager.getClient(TEST_USER.id, OWNER);
      ownerStates.length = 0;

      // A deliberate Connect on the duplicate reaches the runtime and is refused.
      const refusal = await service.connect(TEST_USER.id, DUPLICATE).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(
        refusal instanceof Error ? refusal.message : `connect resolved: ${String(refusal)}`
      ).toContain(String(RUNTIME_ALREADY_BOUND_CLOSE_CODE));
      await waitUntil(
        () => countLines(stderr.text(), 'already bound') === 1,
        'one "already bound" refusal logged by the runtime',
        10_000,
        () => stderr.text()
      );

      const duplicateStatus = manager.getStatus(TEST_USER.id, DUPLICATE);
      expect(duplicateStatus).toMatchObject({ state: 'error', boundElsewhere: true });

      // The observation window: every lazy caller of the duplicate is held by
      // the slow retry instead of dialling the runtime again.
      for (let caller = 0; caller < LAZY_CALLERS; caller += 1) {
        const lazy = await manager.getClient(TEST_USER.id, DUPLICATE).then(
          () => 'connected',
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
        expect(lazy).toMatch(/next connection attempt is allowed in (59|60)s/);
      }

      // The owner answers across the whole window and never left `connected`.
      const health = await ownerClient.health();
      expect(health.runtimeVersion.length).toBeGreaterThan(0);
      expect(manager.getStatus(TEST_USER.id, OWNER).state).toBe('connected');
      expect(ownerStates.filter((state) => state !== 'connected')).toEqual([]);
      expect(countLines(stderr.text(), 'already bound')).toBe(1);
      expect(countLines(stderr.text(), 'superseded')).toBe(0);
    },
    30_000
  );
});
