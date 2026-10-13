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
  requestedRefusalCases,
  SingleTargetDiscovery,
  versionOf,
} from '../../support/external-agents/live-refusals';
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
    // Only the runtime child receives the original credential home. The Hub's
    // database and configuration stay under the canonical isolated test home.
    const peer = spawnPort({
      argv: [binary.path, '--stdio'],
      env: rustSmokeRuntimeEnv(process.env, mangoHome, (await prepare?.(scratch)) ?? {}),
      terminateGraceMs: 2_000,
      killGraceMs: 2_000,
      exitGraceMs: 1_000,
    });
    const hub = await openRustSmokeHub(
      peer,
      async () =>
        openHubSession(peer.port, {
          workspaceBinding: { userId: owner.id, environmentId },
          hubVersion: await rustRuntimeVersion(binary.path),
        }),
      (cleanup) => cleanups.push(cleanup)
    );
    const client = new RuntimeClient(hub, () => undefined, environmentId);
    return { client, owner, chatId, workspace, environmentId };
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
  function recordingSessions(inner: ExternalSessionManager) {
    const refusals: unknown[] = [];
    const manager: ExternalSessionManager = {
      ...inner,
      ensureSession: async (input) => {
        try {
          return await inner.ensureSession(input);
        } catch (error) {
          refusals.push(error);
          throw error;
        }
      },
    };
    return { refusals, manager };
  }

  /** What the person is told for a refused agent, whatever the surface. */
  function expectedRemedy(refusal: LiveRefusalCase): ExternalAgentRemedy {
    if (refusal.reason === 'version-unsupported') return { kind: 'update' };
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
    const session = await startRuntime(refusal.targetId, async (scratch) => {
      const emptyDirectory = join(scratch, 'empty');
      await mkdir(emptyDirectory);
      return refusalEnvironment(refusal, {
        emptyDirectory,
        inheritedPath: process.env.PATH,
        ...(outdatedDirectory ? { outdatedCodexDirectory: outdatedDirectory } : {}),
        ...(refusal.id === 'cursor-signed-out'
          ? { cursorDirectory: executableDirectory('cursor-agent', Bun.which('cursor-agent')) }
          : {}),
      });
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
    return { ...session, scope, discovery, isolationRegistry, live: found.descriptor };
  }

  /** The hub's real send path, resolving against `discovery`, over the live runtime. */
  function sendThrough(
    session: Awaited<ReturnType<typeof refusedSession>>,
    refusal: LiveRefusalCase,
    discovery: Parameters<typeof createExternalTurnConfigurationResolver>[0] extends infer D
      ? D extends { discovery?: infer P }
        ? P
        : never
      : never
  ) {
    const recording = recordingSessions(
      createExternalSessionManager({
        resolveRuntimeClient: () => Promise.resolve(session.client),
        resolveExistingRuntimeClient: () => Promise.resolve(session.client),
      })
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
          prompt: 'Reply with exactly the single word pong. Do not use any tools.',
          attachmentIds: [],
          externalTurn: undefined,
        },
        getDb()
      );
    return { send, recording, stale };
  }

  for (const refusal of LIVE_REFUSAL_CASES) {
    it.skipIf(!binary.available || !refusals.some((entry) => entry.id === refusal.id))(
      `${refusal.id}: the agent is refused as ${refusal.reason}, as the person sees it`,
      async () => {
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
            unavailableReason: refusal.reason,
            remedy: expectedRemedy(refusal),
          });
        } else {
          expect({
            installed: live.installed,
            authState: live.authState,
            unavailableReason: live.unavailableReason,
          }).toEqual({ installed: true, authState: 'unknown', unavailableReason: undefined });
        }
        if (refusal.reason === 'signed-out' && refusal.selectorRefuses) {
          expect(live.authState).toBe('signed-out');
        }
        if (refusal.reason === 'version-unsupported') {
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
            unavailableReason: refusal.reason,
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
        const frames = (await sent.response.text())
          .split('\n\n')
          .filter((frame) => frame.startsWith('data: '))
          .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
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
        }).toEqual({ kind: EXPECTED_KIND[refusal.reason], refusals: 1 });
        expect(frames.find((frame) => frame.type === 'error')).toEqual({
          type: 'error',
          error: GENERIC_OPEN_FAILURE,
          unavailableReason: refusal.reason,
          remedy: expectedRemedy(refusal),
          ...(refusal.reason === 'version-unsupported'
            ? { requiredVersion: live.requiredVersion }
            : {}),
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
});

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
