/**
 * Authenticated smoke: the compiled Rust runtime hosting the real, signed-in
 * vendor CLIs on this machine, driven by the hub's own turn controller.
 *
 * Opt-in and never part of CI. It reaches real vendor accounts, so it runs
 * only when `MANGOSTUDIO_LIVE_AGENT_SMOKE` names the targets to try, e.g.
 * `MANGOSTUDIO_LIVE_AGENT_SMOKE=claude,codex,cursor`. Turns ask for one word,
 * or for a count that is cancelled while it streams, in an empty scratch
 * workspace. No approval is answered, so a tool the vendor wants to run is
 * never granted and nothing on the machine changes. Fixture evidence lives in
 * `rust-runtime-external-agents-qualification.integration.test.ts`; this file
 * is the separate, labelled live evidence.
 *
 * A second, equally opt-in block observes the refusals the fake-driven tests only
 * assume: a signed-out and an outdated agent, through the real runtime and the
 * hub's own selector and send path. `MANGOSTUDIO_LIVE_AGENT_REFUSALS` names the
 * cases (`codex-signed-out,claude-signed-out,cursor-signed-out,codex-outdated`);
 * `MANGOSTUDIO_LIVE_OUTDATED_CODEX_DIR` names the directory holding an older
 * official `codex`. Nothing signs in or out and no credential is read: a signed-out
 * state is the vendor's config-home variable pointed at an empty directory the test
 * creates, and an outdated state is the older binary first on `PATH`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { RemoteError } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  type ExternalAgentRemedy,
  type ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { getDb } from '../../../src/db/database';
import { createDiagnosticLogger } from '../../../src/lib/logger';
import { getChatMessagesUseCase } from '../../../src/modules/chats/application/get-chat-messages';
import {
  createExternalAgentDiscoveryService,
  createRuntimeAuthoritativeAgentDiscovery,
} from '../../../src/modules/external-agents/application/external-agent-discovery';
import { createExternalApprovalRegistry } from '../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalCommandCatalogCache } from '../../../src/modules/external-agents/application/external-command-catalog-cache';
import { acknowledgeExternalDisclosure } from '../../../src/modules/external-agents/application/external-disclosure-gate';
import { createExternalIdentityIsolationRegistry } from '../../../src/modules/external-agents/application/external-identity-isolation';
import {
  createExternalSessionManager,
  type ExternalSessionHandle,
  type ExternalSessionManager,
} from '../../../src/modules/external-agents/application/external-session-manager';
import { createExternalTurnConfigurationResolver } from '../../../src/modules/external-agents/application/external-turn-configuration';
import { createExternalTurnController } from '../../../src/modules/external-agents/application/external-turn-controller';
import { createExternalTurnStream } from '../../../src/modules/external-agents/application/external-turn-stream';
import { grantWorkspaceTrust } from '../../../src/modules/external-agents/application/external-workspace-trust';
import { productDescriptorFor } from '../../../src/modules/external-agents/domain/adapter-descriptors';
import { cancelActiveTurn } from '../../../src/modules/generation/application/active-turn-registry';
import { openHubSession } from '../../../src/services/runtime-client/hub-session';
import { capabilityManifestFromHealth } from '../../../src/services/runtime-client/manifest-from-health';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  CheapPassFake,
  cachedBeforeRefusal,
  executableDirectory,
  isOlderVersion,
  LIVE_REFUSAL_CASES,
  type LiveRefusalCase,
  refusalEnvironment,
  refusedReason,
  requestedRefusalCases,
  requiredExecutable,
  SingleTargetDiscovery,
  sseFrames,
  versionOf,
} from '../../support/external-agents/live-refusals';
import { readProcessSnapshot, vendorProcessesOf } from '../../support/external-agents/process-tree';
import {
  createRustTurnHarness,
  grantRuntimeConsent,
  openRustSmokeHub,
  type RustTurnHarness,
  runRustAgentSmoke,
  rustSmokeConfiguration,
  rustSmokeRuntimeEnv,
  turnPartOf,
  within,
} from '../../support/external-agents/rust-agent-turns';
import { insertTestUser } from '../../support/factories';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const logger = createDiagnosticLogger('live-agent-smoke');
const requested = (process.env.MANGOSTUDIO_LIVE_AGENT_SMOKE ?? '')
  .split(',')
  .map((target) => target.trim())
  .filter((target): target is ExternalAgentTargetId =>
    (EXTERNAL_AGENT_TARGET_IDS as readonly string[]).includes(target)
  );

describe('Authenticated smoke: real vendor CLIs through the Rust runtime', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** One runtime child for `owner`, with `overrides` layered over its environment. */
  async function connectRuntime(
    identity: { owner: { id: string }; environmentId: string; mangoHome: string },
    overrides: Record<string, string>
  ) {
    // Only the runtime child receives the original credential home. The Hub's
    // database and configuration stay under the canonical isolated test home.
    const peer = spawnPort({
      argv: [binary.path, '--stdio'],
      env: rustSmokeRuntimeEnv(process.env, identity.mangoHome, overrides),
      terminateGraceMs: 2_000,
      killGraceMs: 2_000,
      exitGraceMs: 1_000,
    });
    const hub = await openRustSmokeHub(
      peer,
      async () =>
        openHubSession(peer.port, {
          workspaceBinding: { userId: identity.owner.id, environmentId: identity.environmentId },
          hubVersion: await rustRuntimeVersion(binary.path),
        }),
      (cleanup) => cleanups.push(cleanup)
    );
    const client = new RuntimeClient(hub, () => undefined, identity.environmentId);
    return { client, peer };
  }

  /**
   * The compiled runtime with a chat in an empty workspace. `prepare` may create scratch
   * directories and returns variables layered over the runtime child's environment.
   */
  async function startRuntime(
    targetId: ExternalAgentTargetId,
    prepare?: (scratch: string) => Promise<Record<string, string>>
  ) {
    const scratch = await realpath(await scratchMangoHome(`live-smoke-${targetId}`));
    cleanups.push(() => cleanupMangoHome(scratch));
    await mkdir(join(scratch, 'workspace'));
    const workspace = join(scratch, 'workspace');
    const environmentId = `live-smoke-${targetId}`;
    const owner = await insertTestUser();
    const chatId = `chat-${crypto.randomUUID()}`;
    await getDb()
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'live smoke',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: owner.id,
        runnerKind: 'external',
        runnerTargetId: targetId,
        workdir: workspace,
        environmentId,
      })
      .execute();
    cleanups.push(async () => {
      await getDb().deleteFrom('messages').where('chatId', '=', chatId).execute();
      await getDb().deleteFrom('chats').where('id', '=', chatId).execute();
      await getDb().deleteFrom('user').where('id', '=', owner.id).execute();
    });

    const mangoHome = join(scratch, 'mango');
    await mkdir(mangoHome);
    await grantRuntimeConsent(binary.path, mangoHome, 'host');
    const overrides = (await prepare?.(scratch)) ?? {};
    const { client, peer } = await connectRuntime({ owner, environmentId, mangoHome }, overrides);
    return { client, owner, chatId, workspace, environmentId, peer, mangoHome };
  }

  /** A signed-in vendor behind the compiled runtime, with a chat in an empty workspace. */
  async function liveSession(targetId: ExternalAgentTargetId) {
    const { client, owner, chatId, workspace } = await startRuntime(targetId);

    const [descriptor] = (
      await client.externalAgents.discover({ targetIds: [targetId], timeoutMs: 60_000 })
    ).descriptors;
    expect(descriptor).toMatchObject({ targetId, installed: true });
    if (!descriptor)
      throw new Error(`expected an installed ${targetId} descriptor | received: none`);
    const configuration = rustSmokeConfiguration(descriptor);
    logger.info('discovery', {
      targetId,
      version: descriptor.version,
      authState: descriptor.authState,
      discoveryState: descriptor.discoveryState,
      supportedConfigurations: descriptor.supportedConfigurations,
      advertisedModels: descriptor.models?.map(({ id, hidden, isDefault }) => ({
        id,
        hidden,
        isDefault,
      })),
      requestedConfiguration: configuration,
    });

    const credentialHomeFingerprint = client.manifest.identityIsolation?.credentialHomeFingerprint;
    if (!credentialHomeFingerprint) {
      throw new Error(
        `expected the runtime to attest a credential home | received: ${JSON.stringify(client.manifest.identityIsolation)}`
      );
    }
    const turns = createRustTurnHarness({
      client,
      userId: owner.id,
      chatId,
      workspace,
      credentialHomeFingerprint,
      configuration,
    });
    return { turns, owner, chatId };
  }

  /** Runs a one-word turn and returns its persisted `external_turn` part. */
  async function pongTurn(turns: RustTurnHarness, targetId: ExternalAgentTargetId, chatId: string) {
    const result = await within(
      turns.start(
        'Reply with exactly the single word pong and nothing else. Do not use any tools.'
      ),
      `the live ${targetId} turn`,
      170_000
    );
    // A one-word turn can finish before a poll sees it running: read the
    // chat's newest assistant message once it has settled.
    const latest = await getDb()
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chatId)
      .where('role', '=', 'ai')
      .orderBy('timestamp', 'desc')
      .executeTakeFirstOrThrow();
    const row = await turns.assistantRow(latest.id);
    if (result.reason !== 'completed') {
      throw new Error(
        `expected the live ${targetId} turn to complete | received: ${result.reason} ${JSON.stringify(result.error ?? null)}`
      );
    }
    expect(row.text.toLowerCase()).toContain('pong');
    const part = turnPartOf(row.parts);
    logger.info('completed', {
      targetId,
      effectiveConfiguration: turns.effectiveConfiguration(),
      part,
    });
    expect(turns.effectiveConfiguration()).toMatchObject({ level: 'read-only', routing: 'user' });
    return part;
  }

  for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
    it.skipIf(!binary.available || !requested.includes(targetId))(
      `${targetId}: discovers, opens and completes a one-word turn`,
      async () => {
        const { turns, chatId } = await liveSession(targetId);
        await runRustAgentSmoke(turns, () => pongTurn(turns, targetId, chatId));
        expect(turns.liveSessionCount()).toBe(0);
      },
      180_000
    );
  }

  // Claude has no protocol cancel: a Claude cancel is a forced, nonresumable
  // stop on Windows, which the fixture qualification and runtime tests cover.
  for (const targetId of ['codex', 'cursor'] as const) {
    it.skipIf(!binary.available || !requested.includes(targetId))(
      `${targetId}: cancels a streaming turn and completes the next one on the same session`,
      async () => {
        const { turns, owner, chatId } = await liveSession(targetId);
        await runRustAgentSmoke(turns, async () => {
          const running = turns.start(
            'Count from 1 to 300, one number per line, and nothing else. Do not use any tools.'
          );
          const messageId = await runningMessageId(turns);
          await streamingStarted(turns, messageId);
          expect(cancelActiveTurn(messageId, owner.id, chatId, 'user_cancelled')).toBe(true);
          const cancelled = await within(running, `the cancelled live ${targetId} turn`, 120_000);
          expect(cancelled.reason).toBe('cancelled-by-user');
          const cancelledTurn = turnPartOf((await turns.assistantRow(messageId)).parts);
          logger.info('cancelled', { targetId, part: cancelledTurn });

          const next = await pongTurn(turns, targetId, chatId);
          expect(next.sessionId).toBe(cancelledTurn.sessionId);
        });
        expect(turns.liveSessionCount()).toBe(0);
      },
      360_000
    );
  }

  const refusals = requestedRefusalCases(process.env.MANGOSTUDIO_LIVE_AGENT_REFUSALS);
  const GENERIC_OPEN_FAILURE = 'The external agent turn could not be started.';
  const EXPECTED_KIND = {
    'signed-out': 'external_agent_signed_out',
    'version-unsupported': 'external_agent_version_unsupported',
  } as const;

  /** Records every refusal `ensureSession` throws, verbatim, then rethrows it. */
  function recordingSessions(
    inner: ExternalSessionManager,
    afterEnsure?: (handle: ExternalSessionHandle) => Promise<void>
  ) {
    const refusals: unknown[] = [];
    /** Every `ensureSession`, and whether it was a reopen of a connection the hub already had. */
    const calls: Array<{ reopen: boolean }> = [];
    const manager: ExternalSessionManager = {
      ...inner,
      ensureSession: async (input) => {
        calls.push({ reopen: input.existingConnectionOnly === true });
        try {
          const handle = await inner.ensureSession(input);
          if (!input.existingConnectionOnly) await afterEnsure?.(handle);
          return handle;
        } catch (error) {
          refusals.push(error);
          throw error;
        }
      },
    };
    return { refusals, calls, manager };
  }

  /** What the person is told for a refused agent, whatever the surface. */
  function expectedRemedy(refusal: LiveRefusalCase): ExternalAgentRemedy {
    if (refusedReason(refusal) === 'version-unsupported') return { kind: 'update' };
    const command = productDescriptorFor(refusal.targetId)?.loginCommand;
    return { kind: 'sign-in', ...(command ? { command } : {}) };
  }

  /** The version the older `codex` reports about itself. */
  async function outdatedCodexVersion(): Promise<string> {
    const directory = process.env.MANGOSTUDIO_LIVE_OUTDATED_CODEX_DIR ?? '';
    const child = Bun.spawn({ cmd: [join(directory, 'codex'), '--version'], stdout: 'pipe' });
    return versionOf(await new Response(child.stdout).text());
  }

  async function refusedSession(refusal: LiveRefusalCase) {
    const outdatedDirectory = process.env.MANGOSTUDIO_LIVE_OUTDATED_CODEX_DIR?.trim();
    // The reopen flow: the first runtime is plain, on the real signed-in account. A second runtime
    // gets the older `codex` and an empty CODEX_HOME, because the SDK starts `codex app-server`
    // before it gates the version, and an older app-server writes state under the home it runs in.
    let secondRuntimeEnvironment: Record<string, string> = {};
    const session = await startRuntime(refusal.targetId, async (scratch) => {
      const emptyDirectory = join(scratch, 'empty');
      await mkdir(emptyDirectory);
      const environment = refusalEnvironment(refusal, {
        emptyDirectory,
        inheritedPath: process.env.PATH,
        ...(outdatedDirectory ? { outdatedCodexDirectory: outdatedDirectory } : {}),
        ...(refusal.id === 'cursor-signed-out'
          ? { cursorDirectory: executableDirectory('cursor-agent', Bun.which('cursor-agent')) }
          : {}),
      });
      if (refusal.flow !== 'reopen') return environment;
      secondRuntimeEnvironment = environment;
      return {};
    });
    // The connection manager re-reads `runtime.health` right after the handshake: that is where the
    // manifest learns which targets the runtime hosts, and discovery refuses a target it lacks.
    session.client.replaceManifest(
      capabilityManifestFromHealth(await session.client.health(), session.client.manifest)
    );
    // Its own registry: every case is a new user on the same credential home, and the process-wide
    // one would call the second of them contested.
    const isolationRegistry = createExternalIdentityIsolationRegistry();
    const scope = { userId: session.owner.id, environmentId: session.environmentId };
    const discovery = createExternalAgentDiscoveryService({
      probingService: new CheapPassFake(refusal.targetId).asService(),
      authoritative: createRuntimeAuthoritativeAgentDiscovery(
        () => Promise.resolve(new SingleTargetDiscovery(session.client, refusal.targetId)),
        undefined,
        isolationRegistry
      ),
      publishRefresh: () => undefined,
    });
    const found = (await discovery.describeExternalAgents(scope, { waitForAdapter: true })).find(
      (agent) => agent.descriptor.targetId === refusal.targetId
    );
    if (!found) throw new Error(`expected a ${refusal.targetId} descriptor | received: none`);
    return {
      ...session,
      scope,
      discovery,
      isolationRegistry,
      secondRuntimeEnvironment,
      live: found.descriptor,
    };
  }

  /**
   * Hooks that restart the runtime between a send's session open and its submission, as a runtime
   * that restarted would: the first runtime is killed, the hub sees its connection close, and a
   * second runtime (with `secondRuntimeEnvironment` over its environment) answers the reopen.
   */
  function runtimeRestart(session: Awaited<ReturnType<typeof refusedSession>>) {
    let active: RuntimeClient = session.client;
    let armed = false;
    const dropped: number[] = [];
    async function killFirst(): Promise<void> {
      const pid = session.peer.pid;
      if (pid === undefined) throw new Error('expected the first runtime pid | received: none');
      process.kill(pid, 'SIGKILL');
      dropped.push(pid);
      await session.peer.exited;
    }
    async function startSecond(): Promise<void> {
      const second = await connectRuntime(
        {
          owner: session.owner,
          environmentId: session.environmentId,
          mangoHome: session.mangoHome,
        },
        session.secondRuntimeEnvironment
      );
      second.client.replaceManifest(
        capabilityManifestFromHealth(await second.client.health(), second.client.manifest)
      );
      active = second.client;
    }
    async function restartNow(): Promise<void> {
      await killFirst();
      await startSecond();
    }
    return {
      dropped,
      /** The next send restarts the runtime. */
      arm: () => {
        armed = true;
      },
      /** Kills the first runtime now and starts the second, which the hub reaches from then on. */
      restartNow,
      hooks: {
        activeClient: () => active,
        afterEnsure: async (handle: ExternalSessionHandle) => {
          if (!armed) return;
          armed = false;
          await killFirst();
          for (let attempt = 0; attempt < 200 && handle.isLive(); attempt += 1) await Bun.sleep(25);
          if (handle.isLive()) {
            throw new Error(
              'expected the hub to see the first runtime connection close | received: the session is still live'
            );
          }
          await startSecond();
        },
      },
    };
  }

  /** The hub's real send path, resolving against `discovery`, over the live runtime. */
  function sendThrough(
    session: Awaited<ReturnType<typeof refusedSession>>,
    refusal: LiveRefusalCase,
    discovery: Parameters<typeof createExternalTurnConfigurationResolver>[0] extends infer D
      ? D extends { discovery?: infer P }
        ? P
        : never
      : never,
    hooks: {
      /** The client the hub reaches the runtime through; the reopen flow swaps it. */
      readonly activeClient?: () => RuntimeClient;
      readonly afterEnsure?: (handle: ExternalSessionHandle) => Promise<void>;
      /** The prompt of the next send; defaults to a one-word reply. */
      readonly prompt?: () => string;
    } = {}
  ) {
    const active = hooks.activeClient ?? (() => session.client);
    const recording = recordingSessions(
      createExternalSessionManager({
        resolveRuntimeClient: () => Promise.resolve(active()),
        resolveExistingRuntimeClient: () => Promise.resolve(active()),
      }),
      hooks.afterEnsure
    );
    const stale: unknown[] = [];
    const stream = createExternalTurnStream({
      controller: createExternalTurnController({
        sessions: recording.manager,
        approvals: createExternalApprovalRegistry(),
        commandCatalog: createExternalCommandCatalogCache(),
        onDiscoveryStale: (scope) => stale.push(scope),
      }),
      resolveConfiguration: createExternalTurnConfigurationResolver({
        discovery,
        resolveRuntimeClient: () => Promise.resolve(session.client),
        isolationRegistry: session.isolationRegistry,
      }),
      resolveRepoRoot: (workdir) => Promise.resolve(workdir),
    });
    const send = () =>
      stream(
        {
          userId: session.owner.id,
          chat: {
            runner: { kind: 'external', targetId: refusal.targetId },
            runnerPermissions: { level: 'default', routing: 'user' },
            runnerModelSelection: {},
            workdir: session.workspace,
            environmentId: session.environmentId,
            restrictToolsToWorkdir: null,
          },
          chatId: session.chatId,
          prompt:
            hooks.prompt?.() ?? 'Reply with exactly the single word pong. Do not use any tools.',
          attachmentIds: [],
          externalTurn: undefined,
        },
        getDb()
      );
    return { send, recording, stale };
  }

  for (const refusal of LIVE_REFUSAL_CASES.filter((entry) => entry.flow === 'open')) {
    it.skipIf(!binary.available || !refusals.some((entry) => entry.id === refusal.id))(
      `${refusal.id}: the agent is refused as ${refusedReason(refusal)}, as the person sees it`,
      async () => {
        const reason = refusedReason(refusal);
        const session = await refusedSession(refusal);
        const { live } = session;
        logger.info('refusal-discovery', { case: refusal.id, descriptor: live });

        // The selector: what the person sees before sending.
        if (refusal.selectorRefuses) {
          expect({
            installed: live.installed,
            unavailableReason: live.unavailableReason,
            remedy: live.remedy,
          }).toEqual({
            installed: true,
            unavailableReason: reason,
            remedy: expectedRemedy(refusal),
          });
        } else {
          expect({
            installed: live.installed,
            authState: live.authState,
            unavailableReason: live.unavailableReason,
          }).toEqual({ installed: true, authState: 'unknown', unavailableReason: undefined });
        }
        if (reason === 'signed-out' && refusal.selectorRefuses) {
          expect(live.authState).toBe('signed-out');
        }
        if (reason === 'version-unsupported') {
          const oldVersion = await outdatedCodexVersion();
          const required = live.requiredVersion ?? '';
          expect({
            found: live.version,
            olderThanRequired: isOlderVersion(oldVersion, required),
          }).toEqual({ found: oldVersion, olderThanRequired: true });
        }

        if (refusal.selectorRefuses) {
          // The pre-send check, against the live descriptor.
          const preflight = await sendThrough(session, refusal, session.discovery).send();
          expect(preflight.ok ? 'sent' : preflight.failure).toMatchObject({
            kind: 'unsupported',
            unavailableReason: reason,
          });
        }

        // The open. Where the selector already refuses, against a descriptor cached before the
        // state changed (the preflight passes and the runtime itself refuses, as a login that
        // lapsed between two sends would); otherwise against the live one.
        const cached = refusal.selectorRefuses ? cachedBeforeRefusal(live) : live;
        await acknowledgeExternalDisclosure(
          { userId: session.owner.id, targetId: refusal.targetId },
          {
            capabilities: cached.capabilities,
            supportedConfigurations: cached.supportedConfigurations,
          },
          getDb()
        );
        await grantWorkspaceTrust(
          {
            userId: session.owner.id,
            targetId: refusal.targetId,
            environmentId: session.environmentId,
            workspacePath: session.client.paths.canonical(session.workspace),
          },
          getDb()
        );
        const stalePass = sendThrough(session, refusal, {
          describeExternalAgents: () =>
            Promise.resolve([{ descriptor: cached, adapterAnswered: true }]),
        });
        const sent = await within(stalePass.send(), `the refused ${refusal.id} send`, 120_000);
        if (!sent.ok) {
          throw new Error(
            `expected the send to reach the open | received: ${JSON.stringify(sent)}`
          );
        }
        const frames = sseFrames(await sent.response.text());
        const [refused] = stalePass.recording.refusals;
        logger.info('refusal-open', {
          case: refusal.id,
          kind: refused instanceof RemoteError ? refused.details?.kind : undefined,
          code: refused instanceof RemoteError ? refused.code : undefined,
          message: refused instanceof Error ? refused.message : String(refused),
          details: refused instanceof RemoteError ? refused.details : undefined,
          frames,
        });

        expect({
          kind: refused instanceof RemoteError ? refused.details?.kind : String(refused),
          refusals: stalePass.recording.refusals.length,
        }).toEqual({ kind: EXPECTED_KIND[reason], refusals: 1 });
        if (reason === 'version-unsupported') {
          // Both builds are named from the SDK's typed fields: the one found and the floor.
          const found = await outdatedCodexVersion();
          expect({
            message: refused instanceof Error ? refused.message : String(refused),
            foundVersion:
              refused instanceof RemoteError ? refused.details?.foundVersion : undefined,
          }).toEqual({
            message: `expected version ${live.requiredVersion} or newer, received ${found}`,
            foundVersion: found,
          });
        }
        expect(frames.find((frame) => frame.type === 'error')).toEqual({
          type: 'error',
          error: GENERIC_OPEN_FAILURE,
          unavailableReason: reason,
          remedy: expectedRemedy(refusal),
          ...(reason === 'version-unsupported' ? { requiredVersion: live.requiredVersion } : {}),
          done: true,
        });
        expect(stalePass.stale).toEqual([
          {
            userId: session.owner.id,
            environmentId: session.environmentId,
            targetId: refusal.targetId,
          },
        ]);
        // Refused before any turn existed: nothing was written for the chat.
        const stored = await getDb()
          .selectFrom('messages')
          .select('id')
          .where('chatId', '=', session.chatId)
          .execute();
        expect(stored.length).toBe(0);
      },
      240_000
    );
  }

  for (const refusal of LIVE_REFUSAL_CASES.filter((entry) => entry.flow === 'reopen')) {
    it.skipIf(!binary.available || !refusals.some((entry) => entry.id === refusal.id))(
      `${refusal.id}: a reopen refused as outdated reaches the live stream and the stored turn alike`,
      async () => {
        const session = await refusedSession(refusal);
        const { live } = session;
        await acknowledgeExternalDisclosure(
          { userId: session.owner.id, targetId: refusal.targetId },
          {
            capabilities: live.capabilities,
            supportedConfigurations: live.supportedConfigurations,
          },
          getDb()
        );
        await grantWorkspaceTrust(
          {
            userId: session.owner.id,
            targetId: refusal.targetId,
            environmentId: session.environmentId,
            workspacePath: session.client.paths.canonical(session.workspace),
          },
          getDb()
        );

        // The hub reaches the runtime through whichever client is current. The second send drops
        // the first runtime's connection between the open and the submission, as a runtime that
        // restarted would, and the hub's reopen then lands on a runtime whose codex is outdated.
        // (Ending the vendor child instead does not reopen: the runtime reports the session lost,
        // the turn ends `session-lost`, and the next send is an ordinary open.)
        const restart = runtimeRestart(session);
        const pass = sendThrough(session, refusal, session.discovery, restart.hooks);

        // A normal turn on the signed-in account.
        const first = sseFrames(
          await okResponse(await within(pass.send(), 'the first live codex turn', 170_000)).text()
        );
        expect(first.find((frame) => frame.type === 'external_turn_completed')).toMatchObject({
          reason: 'completed',
        });
        expect(first.map((frame) => frame.type)).not.toContain('error');
        const callsBefore = pass.recording.calls.length;

        restart.arm();
        const startedAt = Date.now();
        const second = await within(pass.send(), 'the send after the runtime restarted', 120_000);
        const frames = sseFrames(await okResponse(second).text());
        const elapsedMs = Date.now() - startedAt;
        const refusedWith = pass.recording.refusals[0];
        logger.info('reopen-second-send', {
          elapsedMs,
          droppedRuntimePids: restart.dropped,
          calls: pass.recording.calls.slice(callsBefore),
          refusal:
            refusedWith instanceof RemoteError
              ? {
                  code: refusedWith.code,
                  message: refusedWith.message,
                  details: refusedWith.details,
                }
              : String(refusedWith),
          frames,
        });

        const chunk = frames.find((frame) => frame.type === 'external_error');
        const assistant = frames.find((frame) => frame.type === 'assistant_message_id');
        if (!chunk || !assistant) {
          throw new Error(
            `expected an external_error and an assistant_message_id chunk | received: ${JSON.stringify(frames)}`
          );
        }
        // The transcript as a reload reads it.
        const { messages } = await getChatMessagesUseCase(
          { chatId: session.chatId, userId: session.owner.id },
          getDb()
        );
        const stored = messages
          .find((message) => message.id === assistant.messageId)
          ?.parts?.find((part) => part.type === 'external_turn');
        const presentation = (source: Record<string, unknown> | undefined) => ({
          error: source?.error,
          remedy: source?.remedy,
          unavailableReason: source?.unavailableReason,
          requiredVersion: source?.requiredVersion,
        });
        const floor =
          refusedWith instanceof RemoteError ? refusedWith.details?.requiredVersion : undefined;

        expect(presentation(chunk)).toEqual({
          error: chunk.error,
          remedy: { kind: 'update' },
          unavailableReason: 'version-unsupported',
          requiredVersion: floor,
        });
        expect(floor).toMatch(/^\d+\.\d+\.\d+$/);
        expect(presentation(stored as Record<string, unknown> | undefined)).toEqual(
          presentation(chunk)
        );
        expect(
          frames
            .map((frame) => frame.type)
            .filter((type) =>
              ['external_error', 'external_turn_completed', 'done'].includes(String(type))
            )
        ).toEqual(['external_error', 'external_turn_completed', 'done']);
        // One reopen, refused once, and the hub did not loop on a backoff.
        expect({
          reopens: pass.recording.calls.slice(callsBefore).filter((call) => call.reopen).length,
          refusals: pass.recording.refusals.length,
          kind: refusedWith instanceof RemoteError ? refusedWith.details?.kind : undefined,
        }).toEqual({ reopens: 1, refusals: 1, kind: 'external_agent_version_unsupported' });
        expect(elapsedMs).toBeLessThan(30_000);
      },
      360_000
    );
  }

  for (const refusal of LIVE_REFUSAL_CASES.filter((entry) => entry.flow === 'connection-dropped')) {
    it.skipIf(!binary.available || !refusals.some((entry) => entry.id === refusal.id))(
      `${refusal.id}: a reopen after the runtime connection dropped resumes the conversation`,
      async () => {
        const session = await refusedSession(refusal);
        await acknowledgeExternalDisclosure(
          { userId: session.owner.id, targetId: refusal.targetId },
          {
            capabilities: session.live.capabilities,
            supportedConfigurations: session.live.supportedConfigurations,
          },
          getDb()
        );
        await grantWorkspaceTrust(
          {
            userId: session.owner.id,
            targetId: refusal.targetId,
            environmentId: session.environmentId,
            workspacePath: session.client.paths.canonical(session.workspace),
          },
          getDb()
        );
        // A word the model cannot guess, so a reply that repeats it proves the second session
        // continued the first conversation rather than starting another.
        const codeWord = `mango-${crypto.randomUUID().slice(0, 8)}`;
        let sendNumber = 0;
        const restart = runtimeRestart(session);
        const pass = sendThrough(session, refusal, session.discovery, {
          ...restart.hooks,
          prompt: () => {
            sendNumber += 1;
            return sendNumber === 1
              ? `Remember the code word ${codeWord}. Reply with exactly the single word noted. Do not use any tools.`
              : 'What was the code word I asked you to remember? Reply with exactly the code word and nothing else. Do not use any tools.';
          },
        });

        const first = sseFrames(
          await okResponse(await within(pass.send(), 'the first live claude turn', 170_000)).text()
        );
        expect(first.find((frame) => frame.type === 'external_turn_completed')).toMatchObject({
          reason: 'completed',
        });
        const callsBefore = pass.recording.calls.length;

        restart.arm();
        const second = await within(pass.send(), 'the send after the runtime restarted', 170_000);
        const frames = sseFrames(await okResponse(second).text());
        logger.info('connection-dropped-second-send', {
          droppedRuntimePids: restart.dropped,
          calls: pass.recording.calls.slice(callsBefore),
          frames,
        });

        const text = frames
          .filter((frame) => frame.type === 'external_text')
          .map((frame) => String(frame.text ?? ''))
          .join('');
        const sessions = frames.filter((frame) => frame.type === 'external_session_started');
        expect({
          completed: frames.find((frame) => frame.type === 'external_turn_completed'),
          errors: frames.filter((frame) =>
            ['error', 'external_error'].includes(String(frame.type))
          ),
          recalled: text.includes(codeWord),
          reopens: pass.recording.calls.slice(callsBefore).filter((call) => call.reopen).length,
          resetNotice: sessions.some((frame) => frame.conversationReset !== undefined),
          announced: sessions.length,
        }).toMatchObject({
          completed: { reason: 'completed' },
          errors: [],
          recalled: true,
          reopens: 1,
          resetNotice: false,
          announced: 2,
        });
      },
      420_000
    );
  }

  for (const refusal of LIVE_REFUSAL_CASES.filter((entry) => entry.flow === 'killed-turn')) {
    it.skipIf(!binary.available || !refusals.some((entry) => entry.id === refusal.id))(
      `${refusal.id}: a conversation whose last turn was killed is not resumed`,
      async () => {
        const session = await refusedSession(refusal);
        await acknowledgeExternalDisclosure(
          { userId: session.owner.id, targetId: refusal.targetId },
          {
            capabilities: session.live.capabilities,
            supportedConfigurations: session.live.supportedConfigurations,
          },
          getDb()
        );
        await grantWorkspaceTrust(
          {
            userId: session.owner.id,
            targetId: refusal.targetId,
            environmentId: session.environmentId,
            workspacePath: session.client.paths.canonical(session.workspace),
          },
          getDb()
        );
        // Words the model cannot guess. The code word proves whether the third send continued the
        // first conversation; the closing token exists only in the work the kill cut off.
        const codeWord = `mango-${crypto.randomUUID().slice(0, 8)}`;
        const closing = `done-${crypto.randomUUID().slice(0, 8)}`;
        const prompts = [
          `Remember the code word ${codeWord}. Reply with exactly the single word noted. Do not use any tools.`,
          `Write the numbers from 1 to 600, one per line, with no other text, and then a final line reading ${closing}. Do not use any tools.`,
          'What was the code word I asked you to remember? Reply with exactly the code word, or with exactly the word unknown if you do not have it. Do not use any tools.',
        ];
        let sendNumber = 0;
        const restart = runtimeRestart(session);
        const pass = sendThrough(session, refusal, session.discovery, {
          ...restart.hooks,
          prompt: () => prompts[sendNumber++] ?? prompts[2] ?? '',
        });

        const first = sseFrames(
          await okResponse(await within(pass.send(), 'the first live claude turn', 170_000)).text()
        );
        expect(first.find((frame) => frame.type === 'external_turn_completed')).toMatchObject({
          reason: 'completed',
        });

        // The second send is killed under the vendor: the runtime ends on the first streamed text.
        const killedFrames: Array<Record<string, unknown>> = [];
        const killedResponse = okResponse(await within(pass.send(), 'the long turn', 170_000));
        await readFrames(killedResponse, async (frame) => {
          killedFrames.push(frame);
          if (frame.type === 'external_text' && restart.dropped.length === 0) {
            await restart.restartNow();
          }
        });
        expect(restart.dropped, 'expected the first runtime to be killed mid-turn').toHaveLength(1);

        const third = await within(pass.send(), 'the send after the killed turn', 170_000);
        const frames = sseFrames(await okResponse(third).text());
        logger.info('killed-turn-third-send', {
          droppedRuntimePids: restart.dropped,
          killedEnd: killedFrames.filter((frame) => frame.type === 'external_turn_completed'),
          frames,
        });

        const text = frames
          .filter((frame) => frame.type === 'external_text')
          .map((frame) => String(frame.text ?? ''))
          .join('');
        const sessions = frames.filter((frame) => frame.type === 'external_session_started');
        expect({
          completed: frames.find((frame) => frame.type === 'external_turn_completed'),
          errors: frames.filter((frame) =>
            ['error', 'external_error'].includes(String(frame.type))
          ),
          noticeOnLastAnnouncement: sessions.at(-1)?.conversationReset,
          continuedFirstConversation: text.includes(codeWord),
          continuedKilledWork: text.includes(closing),
        }).toMatchObject({
          completed: { reason: 'completed' },
          errors: [],
          noticeOnLastAnnouncement: 'nonresumable',
          continuedFirstConversation: false,
          continuedKilledWork: false,
        });
      },
      600_000
    );
  }

  for (const refusal of LIVE_REFUSAL_CASES.filter((entry) => entry.flow === 'child-killed')) {
    it.skipIf(!binary.available || !refusals.some((entry) => entry.id === refusal.id))(
      `${refusal.id}: a vendor process that ended between turns is reopened once and the next send completes`,
      async () => {
        const session = await refusedSession(refusal);
        await acknowledgeExternalDisclosure(
          { userId: session.owner.id, targetId: refusal.targetId },
          {
            capabilities: session.live.capabilities,
            supportedConfigurations: session.live.supportedConfigurations,
          },
          getDb()
        );
        await grantWorkspaceTrust(
          {
            userId: session.owner.id,
            targetId: refusal.targetId,
            environmentId: session.environmentId,
            workspacePath: session.client.paths.canonical(session.workspace),
          },
          getDb()
        );
        const pass = sendThrough(session, refusal, session.discovery);

        const first = sseFrames(
          await okResponse(await within(pass.send(), 'the first live codex turn', 170_000)).text()
        );
        expect(first.find((frame) => frame.type === 'external_turn_completed')).toMatchObject({
          reason: 'completed',
        });
        expect(first.map((frame) => frame.type)).not.toContain('error');

        // The app-server this runtime started, found below the runtime by its executable; the
        // developer's own codex sessions are not descendants and are never matched.
        const runtimePid = session.peer.pid;
        if (runtimePid === undefined) throw new Error('expected the runtime pid | received: none');
        const codexPath = await realpath(requiredExecutable('codex', Bun.which('codex')));
        const started = vendorProcessesOf(runtimePid, codexPath, readProcessSnapshot());
        if (started.length !== 1) {
          throw new Error(
            `expected exactly one codex process under the runtime | received: [${started.join(', ')}]`
          );
        }
        const [victim] = started;
        if (victim === undefined) throw new Error('expected a codex pid | received: none');
        process.kill(victim, 'SIGKILL');
        for (let attempt = 0; attempt < 200 && existsSync(`/proc/${victim}`); attempt += 1)
          await Bun.sleep(25);
        // Long enough for the SDK to see its child's pipe close and seal the session.
        await Bun.sleep(1_500);
        const callsBefore = pass.recording.calls.length;

        const startedAt = Date.now();
        const second = await within(
          pass.send(),
          'the send after the vendor process ended',
          150_000
        );
        const frames = sseFrames(await okResponse(second).text());
        const elapsedMs = Date.now() - startedAt;
        logger.info('child-killed-second-send', {
          killedPid: victim,
          elapsedMs,
          calls: pass.recording.calls.slice(callsBefore),
          frames,
        });

        const assistant = frames.find((frame) => frame.type === 'assistant_message_id');
        const text = frames
          .filter((frame) => frame.type === 'external_text')
          .map((frame) => String(frame.text ?? ''))
          .join('');
        expect({
          completed: frames.find((frame) => frame.type === 'external_turn_completed'),
          errors: frames.filter((frame) =>
            ['error', 'external_error'].includes(String(frame.type))
          ),
          answered: /pong/i.test(text),
        }).toMatchObject({ completed: { reason: 'completed' }, errors: [], answered: true });
        // The reopen resumed the vendor conversation: the thread's running total covers both turns.
        const thread = frames.find((frame) => frame.type === 'external_thread_usage') as
          | { usage?: { last?: { totalTokens?: number }; total?: { totalTokens?: number } } }
          | undefined;
        expect({
          thread:
            (thread?.usage?.total?.totalTokens ?? 0) > (thread?.usage?.last?.totalTokens ?? 0),
        }).toEqual({ thread: true });
        // One reopen, and a vendor process that is not the one that was ended.
        const replacements = vendorProcessesOf(runtimePid, codexPath, readProcessSnapshot());
        expect({
          reopens: pass.recording.calls.slice(callsBefore).filter((call) => call.reopen).length,
          replaced: replacements.length === 1 && replacements[0] !== victim,
        }).toEqual({ reopens: 1, replaced: true });
        if (!assistant) {
          throw new Error(
            `expected an assistant_message_id chunk | received: ${JSON.stringify(frames)}`
          );
        }
        const { messages } = await getChatMessagesUseCase(
          { chatId: session.chatId, userId: session.owner.id },
          getDb()
        );
        const stored = messages
          .find((message) => message.id === assistant.messageId)
          ?.parts?.find((part) => part.type === 'external_turn');
        expect(stored).toMatchObject({ status: 'terminal', terminalReason: 'completed' });
      },
      420_000
    );
  }
});

/** The streaming response of an accepted send, or throws with the refusal. */
/**
 * Reads an SSE response frame by frame, handing each to `onFrame` as it arrives (and waiting for
 * it), so a test can act in the middle of a turn.
 */
async function readFrames(
  response: Response,
  onFrame: (frame: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!response.body) throw new Error('expected a streaming response body | received: none');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const pieces = buffer.split('\n\n');
    buffer = pieces.pop() ?? '';
    for (const piece of pieces) {
      if (piece.startsWith('data: ')) {
        await onFrame(JSON.parse(piece.slice('data: '.length)) as Record<string, unknown>);
      }
    }
  }
}

function okResponse(
  result: Awaited<ReturnType<ReturnType<typeof createExternalTurnStream>>>
): Response {
  if (!result.ok) {
    throw new Error(
      `expected the send to be accepted | received: ${JSON.stringify(result.failure)}`
    );
  }
  return result.response;
}

/** The assistant message a just-started turn is writing, once the hub has created it. */
async function runningMessageId(turns: RustTurnHarness): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      return await turns.runningAssistantMessageId();
    } catch (error) {
      last = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`expected the turn to create its assistant message | received: ${String(last)}`);
}

/** Resolves once the vendor has streamed some text into `messageId`. */
async function streamingStarted(turns: RustTurnHarness, messageId: string): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if ((await turns.assistantRow(messageId)).text.length > 0) return;
    await Bun.sleep(100);
  }
  throw new Error('expected the vendor to stream text within 120 s | received: no text');
}
