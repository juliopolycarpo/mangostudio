/**
 * Qualifies the compiled Rust runtime's external-agent admission against the
 * real hub code: its hello and health attestation, the hub's cross-environment
 * collision check, a hub's withdrawal, and the session methods' fail-closed
 * workspace authority, all over a real stdio child.
 *
 * The claim the collision check depends on is byte identity. A spawned runtime
 * attests `os-account` (or `container`) and the in-process Local connector
 * attests `single-user-host`, but both digest the same credential-home identity
 * with no method prefix. So one OS account reached through Local by one user
 * and through a Rust stdio runtime by another produces one fingerprint, and
 * the hub refuses both. A Rust derivation that differed by a single byte would
 * let the second user through, silently.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizedEnv, spawnPort } from '@mangostudio/protocol/spawn';
import { rejectionOf } from '@mangostudio/protocol/testing';
import type { ExternalApprovalPart } from '@mangostudio/shared/types';
import { getDb } from '../../../src/db/database';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { createExternalIdentityIsolationRegistry } from '../../../src/modules/external-agents/application/external-identity-isolation';
import { cancelActiveTurn } from '../../../src/modules/generation/application/active-turn-registry';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import { connectLocalRuntime } from '../../../src/services/runtime-client/connect-in-process-runtime';
import { openHubSession } from '../../../src/services/runtime-client/hub-session';
import type { HubWorkspaceBinding } from '../../../src/services/runtime-client/hub-workspace-authority';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../../src/services/runtime-client/runtime-token-secrets';
import {
  createRustTurnHarness,
  grantRuntimeConsent,
  insertCursorChat,
  installFakeCursorAgent,
  resolveFakeCursorAgent,
  revokeRuntimeConsent,
  runAnsweredTurn,
  turnPartOf,
  within,
} from '../../support/external-agents/rust-agent-turns';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import { connectUntilListening, reserveEphemeralPort } from '../../support/rust-serve-dial';

const binary = resolveRustRuntimeBinary();
const fakeCursorAgent = resolveFakeCursorAgent();

describe('Real Rust runtime external-agent admission', () => {
  let runtimeVersion: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    if (!binary.available) return;
    runtimeVersion = await rustRuntimeVersion(binary.path);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A stdio Rust runtime under a scratch MANGO_HOME, with `env` over the sanitized parent. */
  async function spawnRustRuntime(
    name: string,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly externalAgentIsolation?: 'single-user' | 'withdrawn';
      readonly workspaceBinding?: HubWorkspaceBinding;
      /** A home the caller already prepared, e.g. with consent granted; still cleaned up here. */
      readonly mangoHome?: string;
    } = {}
  ): Promise<RuntimeClient> {
    const mangoHome = options.mangoHome ?? (await scratchMangoHome(name));
    const peer = spawnPort({
      argv: [binary.path, '--stdio'],
      env: { ...sanitizedEnv(process.env, { MANGO_HOME: mangoHome }), ...options.env },
      terminateGraceMs: 2_000,
      killGraceMs: 2_000,
      exitGraceMs: 1_000,
    });
    const hub = await openHubSession(peer.port, {
      // The real hub handler, answering from the test database.
      workspaceBinding: options.workspaceBinding ?? null,
      hubVersion: runtimeVersion,
      ...(options.externalAgentIsolation
        ? { externalAgentIsolation: options.externalAgentIsolation }
        : {}),
    });
    cleanups.push(async () => {
      hub.close();
      await peer.terminate();
      await cleanupMangoHome(mangoHome);
    });
    return new RuntimeClient(hub, () => undefined, name);
  }

  it.skipIf(!binary.available)(
    'attests the credential home Local attests, so the hub sees two users collide',
    async () => {
      const rust = await spawnRustRuntime('rust-external-agents-attest');
      const local = await connectLocalRuntime({
        authorizeWorkspace: () => false,
        externalAgentIsolation: 'single-user',
      });
      cleanups.push(() => local.close());
      const localClient = new RuntimeClient(local.hub, () => undefined, 'local');

      const rustAttestation = rust.manifest.identityIsolation;
      const localAttestation = localClient.manifest.identityIsolation;
      expect(localAttestation?.method).toBe('single-user-host');
      expect(rustAttestation?.method).toMatch(/^(os-account|container)$/);
      // The whole point: one home, one digest, whichever route reached it.
      expect(rustAttestation?.credentialHomeFingerprint).toBe(
        localAttestation?.credentialHomeFingerprint
      );

      const health = await rust.health();
      expect(health.externalAgents).toMatchObject({
        targets: ['codex', 'cursor', 'claude'],
        liveSessionCount: 0,
        liveSessions: [],
        identityIsolation: rustAttestation,
      });

      const reaped: string[] = [];
      const registry = createExternalIdentityIsolationRegistry({
        sessions: {
          reapScope: (scope) => {
            reaped.push(scope.userId ?? '<no user>');
            return Promise.resolve();
          },
        },
      });
      expect(
        registry.resolve({ userId: 'user-a', environmentId: 'local', isolation: localAttestation })
      ).toEqual(localAttestation);
      expect(
        registry.resolve({ userId: 'user-b', environmentId: 'rust', isolation: rustAttestation })
      ).toBeUndefined();
      expect(registry.isContested(rustAttestation?.credentialHomeFingerprint ?? 'missing')).toBe(
        true
      );
      expect(reaped.sort()).toEqual(['user-a', 'user-b']);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'withholds the attestation from a hub that withdrew it',
    async () => {
      const rust = await spawnRustRuntime('rust-external-agents-withdrawn', {
        externalAgentIsolation: 'withdrawn',
      });
      expect(rust.manifest.identityIsolation).toBeUndefined();
      const health = await rust.health();
      expect(health.externalAgents?.identityIsolation).toBeUndefined();
      expect(health.externalAgents?.targets).toEqual(['codex', 'cursor', 'claude']);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'describes uninstalled targets and refuses every workspace through the real hub',
    async () => {
      // An empty PATH and a scratch HOME: no vendor CLI is reachable, so
      // discovery is deterministic and nothing real is launched.
      const home = await scratchMangoHome('rust-external-agents-home');
      cleanups.push(() => cleanupMangoHome(home));
      const emptyPath = join(home, 'empty-path');
      await mkdir(emptyPath);
      const rust = await spawnRustRuntime('rust-external-agents-admission', {
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: emptyPath,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
      });
      // All ten methods are implemented: the capability follows consent.
      expect(rust.manifest.features.externalAgents).toBe(
        rust.manifest.allow?.externalAgents === true
      );

      const discovered = await rust.externalAgents.discover({
        targetIds: ['codex', 'cursor', 'claude'],
        timeoutMs: 20_000,
      });
      expect(
        discovered.descriptors.map((descriptor) => [
          descriptor.targetId,
          descriptor.installed,
          descriptor.unavailableReason,
        ])
      ).toEqual([
        ['codex', false, 'not-installed'],
        ['cursor', false, 'not-installed'],
        ['claude', false, 'not-installed'],
      ]);

      await mkdir(join(home, 'workspace'));
      // Canonical, so the refusal can only be the authority's.
      const workspace = await realpath(join(home, 'workspace'));
      expect(
        await rejectionOf(
          rust.externalAgents.open({
            sessionId: 'qualification-session',
            targetId: 'codex',
            workspacePath: workspace,
            configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
            resumeMode: 'fallback',
            timeoutMs: 10_000,
          })
        )
      ).toMatchObject({ message: expect.stringMatching(/is not authorized/) });
      const health = await rust.health();
      expect(health.externalAgents?.liveSessionCount).toBe(0);
    },
    60_000
  );

  it.skipIf(!binary.available)(
    'admits exactly the workspace the hub authorized for this connection',
    async () => {
      const home = await scratchMangoHome('rust-external-agents-authorized-home');
      cleanups.push(() => cleanupMangoHome(home));
      const emptyPath = join(home, 'empty-path');
      await mkdir(emptyPath);
      await mkdir(join(home, 'authorized'));
      await mkdir(join(home, 'unauthorized'));
      const authorized = await realpath(join(home, 'authorized'));
      const unauthorized = await realpath(join(home, 'unauthorized'));

      const owner = await insertTestUser();
      const environmentId = 'rust-external-agents-authorized';
      const chat = await insertTestChat(owner.id);
      await getDb()
        .updateTable('chats')
        .set({ environmentId, workdir: authorized })
        .where('id', '=', chat.id)
        .execute();
      cleanups.push(async () => {
        await getDb().deleteFrom('chats').where('id', '=', chat.id).execute();
        await getDb().deleteFrom('user').where('id', '=', owner.id).execute();
      });

      const rust = await spawnRustRuntime(environmentId, {
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: emptyPath,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
        workspaceBinding: { userId: owner.id, environmentId },
      });
      const open = (sessionId: string, workspacePath: string) =>
        rust.externalAgents.open({
          sessionId,
          targetId: 'codex',
          workspacePath,
          configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
          resumeMode: 'fallback',
          timeoutMs: 10_000,
        });

      // Past the authority: the only thing missing is the vendor CLI.
      expect(await rejectionOf(open('qualification-authorized', authorized))).toMatchObject({
        message: expect.stringMatching(/is not installed/),
      });
      expect(await rejectionOf(open('qualification-unauthorized', unauthorized))).toMatchObject({
        message: expect.stringMatching(/is not authorized/),
      });
      const health = await rust.health();
      expect(health.externalAgents?.liveSessionCount).toBe(0);
    },
    60_000
  );

  // Symlink creation needs a privilege on Windows.
  it.skipIf(!binary.available || process.platform === 'win32')(
    'authorizes the workdir workspace.validate returned for a symlinked path',
    async () => {
      const home = await scratchMangoHome('rust-external-agents-symlink-home');
      cleanups.push(() => cleanupMangoHome(home));
      const emptyPath = join(home, 'empty-path');
      await mkdir(emptyPath);
      await mkdir(join(home, 'real'));
      await symlink(join(home, 'real'), join(home, 'link'), 'dir');
      const canonical = await realpath(join(home, 'real'));

      const owner = await insertTestUser();
      const environmentId = 'rust-external-agents-symlink';
      const chat = await insertTestChat(owner.id);
      cleanups.push(async () => {
        await getDb().deleteFrom('chats').where('id', '=', chat.id).execute();
        await getDb().deleteFrom('user').where('id', '=', owner.id).execute();
      });

      const rust = await spawnRustRuntime(environmentId, {
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: emptyPath,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
        workspaceBinding: { userId: owner.id, environmentId },
      });

      // The hub stores whatever validate resolves as the chat workdir.
      const validation = await rust.workspace.validate({
        path: join(home, 'link'),
        requireAbsolute: true,
      });
      if (!validation.ok) throw new Error(`expected ok validation, received ${validation.reason}`);
      await getDb()
        .updateTable('chats')
        .set({ environmentId, workdir: validation.resolvedPath })
        .where('id', '=', chat.id)
        .execute();

      // The supervisor only opens canonical paths; past the authority, only the CLI is missing.
      const rejection = await rejectionOf(
        rust.externalAgents.open({
          sessionId: 'qualification-symlink',
          targetId: 'codex',
          workspacePath: canonical,
          configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
          resumeMode: 'fallback',
          timeoutMs: 10_000,
        })
      );
      expect(rejection).toMatchObject({ message: expect.stringMatching(/is not installed/) });
    },
    60_000
  );

  /**
   * A home with the stand-in `cursor-agent` as the only thing on `PATH`, an
   * authorized workspace, a chat on `environmentId` whose workdir is that
   * workspace, and a consent-granted runtime home — everything a real turn
   * needs, and nothing a developer's machine would add.
   */
  async function preparedCursorRuntime(environmentId: string) {
    const home = await scratchMangoHome(`${environmentId}-home`);
    cleanups.push(() => cleanupMangoHome(home));
    const path = await installFakeCursorAgent(fakeCursorAgent, join(home, 'bin'));
    await mkdir(join(home, 'workspace'));
    // Canonical, as the hub stores it (macOS scratch lives under /private/var).
    const workspace = await realpath(join(home, 'workspace'));

    const owner = await insertTestUser();
    const chatId = await insertCursorChat(owner.id, environmentId, workspace);
    cleanups.push(async () => {
      await getDb().deleteFrom('messages').where('chatId', '=', chatId).execute();
      await getDb().deleteFrom('chats').where('id', '=', chatId).execute();
      await getDb().deleteFrom('user').where('id', '=', owner.id).execute();
    });

    const mangoHome = await scratchMangoHome(environmentId);
    await grantRuntimeConsent(binary.path, mangoHome, 'host');
    const rust = await spawnRustRuntime(environmentId, {
      mangoHome,
      env: { HOME: home, USERPROFILE: home, PATH: path, XDG_CONFIG_HOME: join(home, '.config') },
      workspaceBinding: { userId: owner.id, environmentId },
    });
    const credentialHomeFingerprint = rust.manifest.identityIsolation?.credentialHomeFingerprint;
    if (!credentialHomeFingerprint) {
      throw new Error(
        `expected the runtime to attest a credential home | received: ${JSON.stringify(rust.manifest.identityIsolation)}`
      );
    }
    const turns = createRustTurnHarness({
      client: rust,
      userId: owner.id,
      chatId,
      workspace,
      credentialHomeFingerprint,
    });
    return { rust, turns, owner, chatId, mangoHome, path };
  }

  async function waitForLiveSessions(rust: RuntimeClient, expected: number): Promise<void> {
    let last: number | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      last = (await rust.health()).externalAgents?.liveSessionCount;
      if (last === expected) return;
      await Bun.sleep(25);
    }
    throw new Error(`expected ${expected} live runtime sessions | received: ${last}`);
  }

  /** Waits for the runtime to report its one session in `state`, e.g. idle after a cancel. */
  async function waitForSessionState(rust: RuntimeClient, state: string): Promise<void> {
    let last = '<no live session>';
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const sessions = (await rust.health()).externalAgents?.liveSessions ?? [];
      last = JSON.stringify(sessions.map((session) => session.state));
      if (sessions.length === 1 && sessions[0]?.state === state) return;
      await Bun.sleep(25);
    }
    throw new Error(`expected the one runtime session to be ${state} | received states: ${last}`);
  }

  it.skipIf(!binary.available || !fakeCursorAgent.available)(
    'runs, answers, cancels and continues Cursor turns through the hub turn controller',
    async () => {
      const { rust, turns, owner, chatId } = await preparedCursorRuntime(
        'rust-external-agents-turns'
      );
      expect(rust.manifest.allow?.externalAgents).toBe(true);
      expect(rust.manifest.features.externalAgents).toBe(true);
      const discovered = await rust.externalAgents.discover({
        targetIds: ['cursor'],
        timeoutMs: 20_000,
      });
      expect(discovered.descriptors).toMatchObject([
        { targetId: 'cursor', installed: true, version: '2026.09.10-fd3934a' },
      ]);

      // An answered approval: the vendor's own option ids reach the transcript
      // and the answer reaches the vendor, which is what lets the turn end.
      const first = turns.start('first turn');
      const approval = await turns.pendingApproval();
      expect(approval.options.map((option) => option.id)).toEqual(['allow', 'reject']);
      const firstMessageId = await turns.runningAssistantMessageId();
      expect(await turns.answer(approval, 'allow')).toMatchObject({ status: 'accepted' });
      expect((await within(first, 'the answered first turn')).reason).toBe('completed');
      const firstRow = await turns.assistantRow(firstMessageId);
      expect(firstRow.text).toContain('hello');
      expect(
        firstRow.parts.find(
          (part): part is ExternalApprovalPart => part.type === 'external_approval'
        )
      ).toMatchObject({ requestId: approval.requestId, decision: 'allow', decisionSource: 'user' });
      const firstTurn = turnPartOf(firstRow.parts);
      expect(firstTurn).toMatchObject({ status: 'terminal', terminalReason: 'completed' });

      // A user cancel while the vendor waits on its question: the question is
      // withdrawn and the vendor reports the turn cancelled.
      const second = turns.start('second turn');
      await turns.pendingApproval();
      const secondMessageId = await turns.runningAssistantMessageId();
      expect(cancelActiveTurn(secondMessageId, owner.id, chatId, 'user_cancelled')).toBe(true);
      expect((await within(second, 'the cancelled second turn')).reason).toBe('cancelled-by-user');

      // The vendor settled the cancel, so the runtime frees the session, and
      // the next turn runs on the same runtime session and vendor process.
      await waitForSessionState(rust, 'idle');
      const third = turns.start('third turn');
      const thirdApproval = await turns.pendingApproval();
      const thirdMessageId = await turns.runningAssistantMessageId();
      await turns.answer(thirdApproval, 'allow');
      expect((await within(third, 'the third turn after a cancel')).reason).toBe('completed');
      const thirdTurn = turnPartOf((await turns.assistantRow(thirdMessageId)).parts);
      expect(thirdTurn.sessionId).toBe(firstTurn.sessionId);
      expect(thirdTurn.nativeTurnId).not.toBe(firstTurn.nativeTurnId);

      await turns.close();
      expect(turns.liveSessionCount()).toBe(0);
      await waitForLiveSessions(rust, 0);
    },
    90_000
  );

  it.skipIf(!binary.available || !fakeCursorAgent.available)(
    'ends a waiting turn and closes its session when the machine withdraws consent',
    async () => {
      const { rust, turns, mangoHome } = await preparedCursorRuntime(
        'rust-external-agents-revoked'
      );
      const running = turns.start('a turn consent is withdrawn from');
      await turns.pendingApproval();
      await waitForLiveSessions(rust, 1);

      await revokeRuntimeConsent(binary.path, mangoHome, 'host');

      // The runtime stops the vendor and closes the session. The wire carries no
      // reason for a runtime-side stop, so the hub records what it saw: the
      // vendor ended the turn early. Hub-side withdrawal is `consent-revoked`.
      const result = await within(running, 'the turn consent was withdrawn from');
      expect(result.reason).toBe('interrupted');
      await waitForLiveSessions(rust, 0);
      expect((await rust.health()).allow.externalAgents).toBe(false);
    },
    90_000
  );
});

describe('Real Rust runtime external-agent turns over a direct-URL serve connection', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it.skipIf(!binary.available || !fakeCursorAgent.available)(
    'authorizes the environment owner and runs an answered turn through the hub controller',
    async () => {
      const home = await scratchMangoHome('rust-external-agents-serve-home');
      cleanups.push(() => cleanupMangoHome(home));
      const path = await installFakeCursorAgent(fakeCursorAgent, join(home, 'bin'));
      await mkdir(join(home, 'workspace'));
      const workspace = await realpath(join(home, 'workspace'));

      const owner = await insertTestUser();
      const environmentId = 'rust-external-agents-serve-box';
      const chatId = await insertCursorChat(owner.id, environmentId, workspace);
      cleanups.push(async () => {
        await getDb().deleteFrom('messages').where('chatId', '=', chatId).execute();
        await getDb().deleteFrom('chats').where('id', '=', chatId).execute();
        await getDb().deleteFrom('environments').where('userId', '=', owner.id).execute();
        await getDb().deleteFrom('user').where('id', '=', owner.id).execute();
      });

      const mangoHome = await scratchMangoHome('rust-external-agents-serve');
      cleanups.push(() => cleanupMangoHome(mangoHome));
      // `serve` answers as the `remote` slot.
      await grantRuntimeConsent(binary.path, mangoHome, 'remote');
      const store = new InMemorySecretStore();
      setRuntimeTokenStoreForTests(store);
      cleanups.push(() => {
        setRuntimeTokenStoreForTests(undefined);
        return Promise.resolve();
      });
      const token = 'rust-external-agents-serve-token';
      const port = reserveEphemeralPort();
      const child = Bun.spawn({
        cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
        env: {
          ...sanitizedEnv(process.env, { MANGO_HOME: mangoHome }),
          MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token,
          HOME: home,
          USERPROFILE: home,
          PATH: path,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      cleanups.push(async () => {
        child.kill();
        await child.exited;
      });

      const repository = createEnvironmentRepository(getDb());
      const manager = new RuntimeConnectionManager({
        resolveEnvironment: async (userId, id) => repository.find(userId, id),
        connectors: { http: connectHttpRuntime },
      });
      setRuntimeConnectionManagerForTests(manager);
      cleanups.push(() => {
        manager.disconnect(owner.id, environmentId);
        setRuntimeConnectionManagerForTests(undefined);
        return Promise.resolve();
      });
      const service = createEnvironmentService(repository, manager, () => undefined, store);
      await service.create(owner.id, {
        id: environmentId,
        name: 'Rust external-agents serve box',
        transportKind: 'http',
        config: { baseUrl: `http://127.0.0.1:${port}` },
        token,
      });
      await connectUntilListening(() => service.connect(owner.id, environmentId));
      const client = await manager.getClient(owner.id, environmentId);
      const credentialHomeFingerprint =
        client.manifest.identityIsolation?.credentialHomeFingerprint;
      if (!credentialHomeFingerprint) {
        throw new Error(
          `expected the serve runtime to attest a credential home | received: ${JSON.stringify(client.manifest.identityIsolation)}`
        );
      }

      const turns = createRustTurnHarness({
        client,
        userId: owner.id,
        chatId,
        workspace,
        credentialHomeFingerprint,
      });
      const { result, row } = await runAnsweredTurn(turns, 'hello over serve');
      expect(result.reason).toBe('completed');
      expect(row.text).toContain('hello');
      await turns.close();
      expect((await client.health()).externalAgents?.liveSessionCount).toBe(0);
    },
    90_000
  );
});
