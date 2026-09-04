import { beforeEach, describe, expect, it } from 'bun:test';
import type { ChatAttachmentKind } from '@mangostudio/shared/chat';
import type {
  ExternalAgentCapabilities,
  ExternalAgentDescriptor,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_ATTACHMENT_MAX_BYTES,
  EXTERNAL_TURN_MAX_ATTACHMENTS,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import type { Kysely } from 'kysely';
import { getDb } from '../../../../src/db/database';
import type { Database } from '../../../../src/db/types';
import type { OwnedChatRecord } from '../../../../src/modules/chats/infrastructure/chat-repository';
import { createExternalApprovalRegistry } from '../../../../src/modules/external-agents/application/external-approval-registry';
import { acknowledgeExternalDisclosure } from '../../../../src/modules/external-agents/application/external-disclosure-gate';
import { createExternalSessionManager } from '../../../../src/modules/external-agents/application/external-session-manager';
import { createExternalTurnConfigurationResolver } from '../../../../src/modules/external-agents/application/external-turn-configuration';
import { createExternalTurnController } from '../../../../src/modules/external-agents/application/external-turn-controller';
import { createExternalTurnStream } from '../../../../src/modules/external-agents/application/external-turn-stream';
import { grantWorkspaceTrust } from '../../../../src/modules/external-agents/application/external-workspace-trust';
import {
  cancelActiveTurn,
  findActiveTurnByChat,
} from '../../../../src/modules/generation/application/active-turn-registry';
import {
  createFakeExternalRuntime,
  type FakeExternalRuntime,
} from '../../../support/external-agents/fake-external-runtime';
import { insertTestUser } from '../../../support/factories';

const EVERY_PAIR: readonly ExternalSupportedConfiguration[] = [
  { level: 'read-only', routing: 'user', supported: true, unattended: false },
  { level: 'default', routing: 'user', supported: true, unattended: false },
  { level: 'full-access', routing: 'user', supported: true, unattended: true },
  {
    level: 'default',
    routing: 'auto-review',
    supported: false,
    unattended: true,
    unsupportedReasonKey: 'externalAgents.unsupported.codexProfileDisallowed',
  },
];

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, structuredStreaming: true },
    supportedConfigurations: EVERY_PAIR,
    account: { label: 'someone', fingerprint: 'fingerprint-a' },
    ...overrides,
  };
}

let userId = '';
let chatId = '';

async function insertExternalChat(
  permissions: { level?: string; routing?: string } = { level: 'default', routing: 'user' }
): Promise<string> {
  const id = `chat-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id,
      title: 'external chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      runnerPermissionLevel: permissions.level ?? null,
      runnerApprovalRouting: permissions.routing ?? null,
      workdir: '/work/repo',
      environmentId: 'local',
    })
    .execute();
  return id;
}

function chatRecord(overrides: Partial<OwnedChatRecord> = {}): OwnedChatRecord {
  return {
    runner: { kind: 'external', targetId: 'codex' },
    runnerPermissions: { level: 'default', routing: 'user' },
    runnerModelSelection: {},
    workdir: '/work/repo',
    environmentId: 'local',
    restrictToolsToWorkdir: null,
    ...overrides,
  };
}

function harness(
  options: {
    readonly agents?: readonly ExternalAgentDescriptor[];
    /** False for a cold discovery cache: descriptors are placeholders, not findings. */
    readonly adapterAnswered?: boolean;
    /** Stands in for the runtime's `git rev-parse`; null is "not a repository". */
    readonly repoRoot?: (workdir: string) => string | null | Promise<string | null>;
    readonly repoRootFailure?: () => Error;
    /** What the opened session reports it can do, as opposed to the descriptor. */
    readonly sessionCapabilities?: ExternalAgentCapabilities;
  } = {}
) {
  const runtime = createFakeExternalRuntime(
    options.sessionCapabilities ? { capabilities: options.sessionCapabilities } : {}
  );
  const sessions = createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    newSessionId: () => `session-${crypto.randomUUID()}`,
  });
  const approvals = createExternalApprovalRegistry();
  const controller = createExternalTurnController({ sessions, approvals });
  const resolveConfiguration = createExternalTurnConfigurationResolver({
    resolveRuntimeClient: () => Promise.resolve(runtime.client),
    discovery: {
      // `adapterAnswered` unless a case says otherwise: every existing test here
      // is about what a vendor that *did* answer supports, not about a cold cache.
      describeExternalAgents: () =>
        Promise.resolve(
          (options.agents ?? [descriptor()]).map((agent) => ({
            descriptor: agent,
            adapterAnswered: options.adapterAnswered ?? true,
          }))
        ),
    },
  });
  const repoRootCalls: Array<{ workdir: string; selection: unknown }> = [];
  const stream = createExternalTurnStream({
    controller,
    resolveConfiguration,
    resolveRepoRoot: (workdir, _signal, selection) => {
      repoRootCalls.push({ workdir, selection });
      const failure = options.repoRootFailure?.();
      if (failure) return Promise.reject(failure);
      return Promise.resolve(options.repoRoot ? options.repoRoot(workdir) : workdir);
    },
  });
  return { runtime, controller, approvals, resolveConfiguration, stream, repoRootCalls };
}

/** Reads SSE frames off the response until the stream closes. */
async function readChunks(response: Response): Promise<StreamChunk[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as StreamChunk);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForTurnStart(runtime: FakeExternalRuntime): Promise<void> {
  return waitFor(() => runtime.calls.turn.length === 1, 'the turn to reach the runtime');
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = await insertExternalChat();
  // The third-party disclosure is a precondition of *every* send, so a suite
  // about what a turn streams has to satisfy it or every case below would assert
  // the refusal instead. The refusal itself is exercised in its own describe.
  await acknowledgeExternalDisclosure(
    { userId, targetId: 'codex' },
    { capabilities: descriptor().capabilities, supportedConfigurations: EVERY_PAIR },
    getDb()
  );
});

describe('the third-party disclosure gate', () => {
  /**
   * Authoritative, and not the descriptor's cached `disclosure-required`: this
   * is the check the external API hits too, which is what makes the gate a
   * safeguard rather than a courtesy the browser extends to itself.
   */
  it('refuses a send from a user who has not acknowledged the vendor', async () => {
    const stranger = await insertTestUser();
    const strangerChat = await insertExternalChat();

    const { stream } = harness();
    const result = await stream(
      {
        userId: stranger.id,
        chat: chatRecord(),
        chatId: strangerChat,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('disclosure-required');
  });

  it('does not let one vendor stand in for another', async () => {
    // Codex is acknowledged for this user; Cursor is not. One dialog must never
    // stand in for another company's terms.
    const { stream } = harness({ agents: [descriptor({ targetId: 'cursor' })] });
    const result = await stream(
      {
        userId,
        chat: chatRecord({ runner: { kind: 'external', targetId: 'cursor' } }),
        chatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('disclosure-required');
  });

  /**
   * The send path never fingerprints the cheap pass, and this is why.
   *
   * A scan-only descriptor claims no capability and no permission pair, so
   * configuration refuses it before the gate is reached. Without that shield,
   * comparing an acknowledgement against the placeholder would refuse an
   * acknowledged user's send as `disclosure-required` — sending them to a dialog
   * they had already answered, which no amount of clicking would clear.
   */
  it('refuses a send on a scan-only descriptor before it reaches the gate', async () => {
    const { stream } = harness({
      agents: [
        descriptor({
          capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
          supportedConfigurations: [],
        }),
      ],
    });
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unsupported');
  });
});

describe('external turn configuration', () => {
  it('refuses a pair the adapter did not vet', async () => {
    const { resolveConfiguration } = harness();
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord({ runnerPermissions: { level: 'default', routing: 'auto-review' } }),
      targetId: 'codex',
      workdir: '/work/repo',
    });
    expect(resolution.ok).toBe(false);
  });

  it('resolves an unmade choice to the restrictive end of both axes', async () => {
    const { resolveConfiguration } = harness();
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord({ runnerPermissions: {} }),
      targetId: 'codex',
      workdir: '/work/repo',
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.configuration.level).toBe('read-only');
    expect(resolution.configuration.routing).toBe('user');
  });

  it('canonicalizes the workspace with the target machine path semantics', async () => {
    const { resolveConfiguration } = harness();
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord(),
      targetId: 'codex',
      workdir: '/work/repo///',
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.canonicalWorkspacePath).toBe('/work/repo');
    expect(resolution.configuration.workspaceRoots).toEqual(['/work/repo']);
    expect(resolution.vendorAccountFingerprint).toBe('fingerprint-a');
  });

  it('falls back to the vendor default when the request names a model the catalog lost', async () => {
    const { resolveConfiguration } = harness({
      agents: [
        descriptor({
          models: [
            { id: 'gpt-5.6-sol', isDefault: true, supportedReasoningEfforts: [{ id: 'high' }] },
            { id: 'gpt-5.6-mini' },
          ],
        }),
      ],
    });
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord(),
      targetId: 'codex',
      workdir: '/work/repo',
      request: { model: 'a-model-that-was-removed', effort: 'nonsense' },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.configuration.model).toBe('gpt-5.6-sol');
    // The requested effort belongs to no listed model, so the chosen model's own
    // catalog decides — and it advertises no default, so nothing is sent.
    expect(resolution.configuration.effort).toBeUndefined();
  });

  it('refuses a target discovery reports as unavailable', async () => {
    const { resolveConfiguration } = harness({
      agents: [descriptor({ unavailableReason: 'signed-out' })],
    });
    const resolution = await resolveConfiguration({
      userId,
      chat: chatRecord(),
      targetId: 'codex',
      workdir: '/work/repo',
    });
    expect(resolution.ok).toBe(false);
  });
});

describe('external turn stream', () => {
  it('streams a text turn as external chunks and finishes with done', async () => {
    const { runtime, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'summarize the repo',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'text_delta', text: 'a repo' });
    runtime.emit({
      type: 'activity_started',
      callId: 'call-1',
      activity: { name: 'shell', kind: 'command', title: 'ls' },
    });
    runtime.emit({ type: 'activity_completed', callId: 'call-1', result: { status: 'completed' } });
    runtime.emit({ type: 'usage', usage: { inputTokens: 11 } });
    runtime.emit({ type: 'completed' });

    const chunks = await reading;
    const types = chunks.map((chunk) => chunk.type);
    expect(types).toEqual([
      'external_session_started',
      'user_message_id',
      'assistant_message_id',
      'external_text',
      'external_activity_started',
      'external_activity_completed',
      'external_usage',
      'external_turn_completed',
      'done',
    ]);
    // The vendor's own session handle never reaches the client.
    expect(JSON.stringify(chunks)).not.toContain('native-session-1');
  });

  it('streams an approval request and its resolution', async () => {
    const { runtime, controller, approvals, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'delete the build folder',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!result.ok) throw new Error('the send was refused');

    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run `rm -rf build`',
        options: [
          { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
          { id: 'deny', rawLabel: 'Deny', isDestructive: true },
        ],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    // The registry binds the approval when the envelope is applied, which the
    // emit above only *schedules*. Waiting on the registry itself is what makes
    // the rejection below a statement about the option id rather than a race
    // with an approval that has not registered yet.
    await waitFor(() => approvals.pendingCount(chatId) === 1, 'the approval to bind');

    const rejected = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'not-an-option',
    });
    expect(rejected).toEqual({ status: 'rejected', reason: 'unknown-option' });

    const accepted = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'approve',
    });
    expect(accepted.status).toBe('accepted');
    expect(runtime.calls.respond).toHaveLength(1);
    expect(runtime.calls.respond[0]?.optionId).toBe('approve');

    runtime.emit({ type: 'completed' });
    const chunks = await reading;
    const request = chunks.find((chunk) => chunk.type === 'external_approval_request');
    expect(request).toMatchObject({
      requestId: 'req-1',
      options: [
        { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
        { id: 'deny', rawLabel: 'Deny', isDestructive: true },
      ],
    });
  });

  it('binds an answer to the live turn without the client naming it', async () => {
    const { runtime, controller, approvals, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'delete the build folder',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!result.ok) throw new Error('the send was refused');
    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({
      type: 'approval_requested',
      request: {
        requestId: 'req-1',
        kind: 'command',
        title: 'Run `rm -rf build`',
        options: [{ id: 'approve', isDestructive: false }],
        expiresAtMs: Date.now() + 60_000,
      },
    });
    await waitFor(() => approvals.pendingCount(chatId) === 1, 'the approval to bind');

    // The client sends only the request and option ids; the session and vendor
    // turn ids are server-owned and never cross the wire. The controller has to
    // supply them, or the registry's binding check is vacuous.
    const accepted = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'approve',
    });
    expect(accepted.status).toBe('accepted');
    expect(runtime.calls.respond[0]).toMatchObject({ nativeTurnId: 'native-turn-1' });

    runtime.emit({ type: 'completed' });
    await reading;

    // Once the turn is gone the same answer no longer binds to anything, so a
    // card left over from it cannot reach a later turn.
    const afterwards = await controller.answerApproval({
      userId,
      chatId,
      requestId: 'req-1',
      optionId: 'approve',
    });
    expect(afterwards.status).toBe('rejected');
  });

  it('preserves a vendor error structure on the wire', async () => {
    const { runtime, stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'break',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!result.ok) throw new Error('the send was refused');

    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({
      type: 'error',
      error: {
        code: 'vendor_failed',
        message: 'sandbox denied',
        vendorCode: 'E_SANDBOX',
        retryable: false,
      },
    });

    const chunks = await reading;
    expect(chunks.find((chunk) => chunk.type === 'external_error')).toMatchObject({
      error: { code: 'vendor_failed', vendorCode: 'E_SANDBOX', retryable: false },
    });
  });

  it('reports the terminal reason for a cancel and for a dropped runtime', async () => {
    const cancelled = harness();
    const cancelledResult = await cancelled.stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'long job',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!cancelledResult.ok) throw new Error('the send was refused');
    const cancelledReading = readChunks(cancelledResult.response);
    await waitForTurnStart(cancelled.runtime);
    expect(cancelActiveTurnForChat(chatId)).toBe(true);
    const cancelledChunks = await cancelledReading;
    expect(cancelledChunks).toContainEqual({
      type: 'external_turn_completed',
      reason: 'cancelled-by-user',
      done: false,
    });
    expect(cancelledChunks.at(-1)?.type).toBe('done');

    const droppedChatId = await insertExternalChat();
    const dropped = harness();
    const droppedResult = await dropped.stream(
      {
        userId,
        chat: chatRecord(),
        chatId: droppedChatId,
        prompt: 'long job',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!droppedResult.ok) throw new Error('the send was refused');
    const droppedReading = readChunks(droppedResult.response);
    await waitForTurnStart(dropped.runtime);
    dropped.runtime.dropConnection();
    const droppedChunks = await droppedReading;
    expect(droppedChunks).toContainEqual({
      type: 'external_turn_completed',
      reason: 'runtime-disconnected',
      done: false,
    });
  });

  it('refuses a chat with no workspace before any header is written', async () => {
    const { stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord({ workdir: null }),
        chatId,
        prompt: 'anything',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: 'validation' } });
  });

  it('refuses an unsupported permission pair with a conflict rather than a stream', async () => {
    const { stream } = harness();
    const result = await stream(
      {
        userId,
        chat: chatRecord({ runnerPermissions: { level: 'default', routing: 'auto-review' } }),
        chatId,
        prompt: 'anything',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unsupported' } });
  });

  /**
   * A cold discovery cache serves a cheap-pass descriptor, whose
   * `supportedConfigurations` is empty — so the pair check refuses every send
   * and used to blame the chat's permission setting. Nothing was asked and
   * nothing is wrong with the setting; the remedy is to try again once the
   * authoritative pass lands, and telling the user to change something sends
   * them to fix a setting that was never the problem.
   */
  it('says a send against a cold cache is not ready yet, not that the pair is unsupported', async () => {
    // The cheap pass's own shape: a binary was found, and nothing has been
    // asked what it will do, so the pair list is empty rather than restrictive.
    const { stream } = harness({
      adapterAnswered: false,
      agents: [descriptor({ supportedConfigurations: [] })],
    });
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'anything',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not `unsupported`: that is the permission-pair refusal, and a cold cache
    // was never asked what it supports. `unavailable` is the same kind the
    // disclosure route already uses for this exact `!adapterAnswered` case.
    expect(result.failure.kind).toBe('unavailable');
    expect(result.failure.message).not.toContain('permission combination');
    expect(result.failure.message).toContain('Try again');
  });

  it('refuses a second send while a turn is live', async () => {
    const { runtime, stream } = harness();
    const first = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'first',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    if (!first.ok) throw new Error('the first send was refused');
    const reading = readChunks(first.response);
    await waitForTurnStart(runtime);

    const second = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'second',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(second).toMatchObject({ ok: false, failure: { kind: 'conflict' } });

    runtime.emit({ type: 'completed' });
    await reading;
  });
});

/** Cancels whatever turn the chat currently holds, exactly as the stop endpoint does. */
function cancelActiveTurnForChat(id: string): boolean {
  const active = findActiveTurnByChat(id);
  if (!active) return false;
  return cancelActiveTurn(active.messageId, userId, id, 'user_cancelled');
}

describe('workspace trust', () => {
  /**
   * The disclosure runs first, deliberately: nobody should be asked whether a
   * vendor may read a folder before they have agreed to use that vendor at all.
   * So these cases acknowledge Cursor and then assert the *workspace* gate.
   */
  beforeEach(async () => {
    await acknowledgeExternalDisclosure(
      { userId, targetId: 'cursor' },
      { capabilities: descriptor().capabilities, supportedConfigurations: EVERY_PAIR },
      getDb()
    );
  });

  it('refuses a Cursor turn against a workspace nobody has trusted', async () => {
    // Not a validation failure and not a conflict: the request is well-formed
    // and will stay refused until a person makes one decision.
    const cursorChatId = await insertExternalChat();
    await getDb()
      .updateTable('chats')
      .set({ runnerTargetId: 'cursor' })
      .where('id', '=', cursorChatId)
      .execute();
    const { stream } = harness({ agents: [descriptor({ targetId: 'cursor' })] });

    const result = await stream(
      {
        userId,
        chat: chatRecord({ runner: { kind: 'external', targetId: 'cursor' } }),
        chatId: cursorChatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('workspace-trust');
    // The disclosure has to name what gets loaded, and only the machine running
    // the vendor can spell it. The vendor and machine travel with the path
    // because the grant is checked against this whole scope, not just the part
    // the dialog prints.
    expect(result.failure).toMatchObject({
      workspacePath: '/work/repo',
      targetId: 'cursor',
      environmentId: 'local',
    });
  });

  /**
   * The gate runs before the uploads are read, not after.
   *
   * Resolving attachments reads up to four files off disk and base64-encodes
   * them. Doing that in front of a refusal the user has to answer spends the
   * work twice — once on the send that is refused and again on the retry the
   * dialog produces — and spends it on behalf of a vendor they have not agreed
   * to let read the folder yet. Asserted through an id nobody owns, because
   * that is the one refusal only the resolver can raise: seeing `validation`
   * here means the resolver ran before the gate did.
   */
  it('refuses an untrusted workspace before it reads the attachments', async () => {
    const cursorChatId = await insertExternalChat();
    await getDb()
      .updateTable('chats')
      .set({ runnerTargetId: 'cursor' })
      .where('id', '=', cursorChatId)
      .execute();
    const imageCapable: ExternalAgentCapabilities = {
      ...NO_EXTERNAL_AGENT_CAPABILITIES,
      structuredStreaming: true,
      images: true,
    };
    // The disclosure runs ahead of this gate and is fingerprinted over what the
    // user was shown, so the image-capable descriptor needs its own — otherwise
    // this asserts the disclosure refusal rather than the trust one.
    await acknowledgeExternalDisclosure(
      { userId, targetId: 'cursor' },
      { capabilities: imageCapable, supportedConfigurations: EVERY_PAIR },
      getDb()
    );
    const { stream } = harness({
      agents: [descriptor({ targetId: 'cursor', capabilities: imageCapable })],
      sessionCapabilities: imageCapable,
    });

    const result = await stream(
      {
        userId,
        chat: chatRecord({ runner: { kind: 'external', targetId: 'cursor' } }),
        chatId: cursorChatId,
        prompt: 'what is in this picture',
        attachmentIds: [crypto.randomUUID()],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('workspace-trust');
  });

  it('lets the same turn through once the workspace is trusted', async () => {
    const cursorChatId = await insertExternalChat();
    await getDb()
      .updateTable('chats')
      .set({ runnerTargetId: 'cursor' })
      .where('id', '=', cursorChatId)
      .execute();
    await grantWorkspaceTrust(
      { userId, targetId: 'cursor', environmentId: 'local', workspacePath: '/work/repo' },
      getDb()
    );
    const { stream, runtime } = harness({ agents: [descriptor({ targetId: 'cursor' })] });

    const result = await stream(
      {
        userId,
        chat: chatRecord({ runner: { kind: 'external', targetId: 'cursor' } }),
        chatId: cursorChatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reading = readChunks(result.response);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'completed' });
    await reading;
    expect(runtime.calls.turn).toHaveLength(1);
  });

  it('never gates a vendor that has not declared what it loads', async () => {
    // The Codex chat above runs untouched: adding the gate must not re-prompt
    // every existing user of an adapter this disclosure says nothing about.
    const { stream } = harness();

    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );

    expect(result.ok).toBe(true);
  });
});

describe('the native review action', () => {
  const REVIEW = { target: { type: 'uncommittedChanges' as const } };
  const REVIEWING_CAPABILITIES: ExternalAgentCapabilities = {
    ...NO_EXTERNAL_AGENT_CAPABILITIES,
    structuredStreaming: true,
    nativeReview: true,
  };
  const REVIEWING_AGENT = descriptor({ capabilities: REVIEWING_CAPABILITIES });

  /** Both halves agree: the cached descriptor *and* the session that opened. */
  function reviewHarness(overrides: Parameters<typeof harness>[0] = {}) {
    return harness({
      agents: [REVIEWING_AGENT],
      sessionCapabilities: REVIEWING_CAPABILITIES,
      ...overrides,
    });
  }

  beforeEach(async () => {
    // The acknowledgement is fingerprinted over the capability set the user was
    // shown, and this suite's agent advertises one more capability than the
    // default descriptor does — so it needs its own, or every case here would
    // assert the disclosure refusal instead.
    await acknowledgeExternalDisclosure(
      { userId, targetId: 'codex' },
      {
        capabilities: REVIEWING_AGENT.capabilities,
        supportedConfigurations: REVIEWING_AGENT.supportedConfigurations,
      },
      getDb()
    );
  });

  function reviewInput() {
    return {
      userId,
      chat: chatRecord(),
      chatId,
      prompt: 'Review my uncommitted changes.',
      attachmentIds: [] as readonly string[],
      externalTurn: undefined,
      review: REVIEW,
    };
  }

  it('starts a review turn and streams it like any other turn', async () => {
    const { stream, runtime } = reviewHarness();
    const result = await stream(reviewInput(), getDb());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await waitFor(() => runtime.calls.startReview.length === 1, 'the review to reach the runtime');
    runtime.emit({ type: 'text_delta', text: 'P1: the retry loop never exits.' });
    runtime.emit({ type: 'completed' });

    const chunks = await readChunks(result.response);
    expect(chunks.map((chunk) => chunk.type)).toContain('external_text');
    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    // The composer's path was not used: no `external-agent.turn` was sent.
    expect(runtime.calls.turn).toHaveLength(0);
  });

  it('refuses a workspace that is not a Git repository', async () => {
    // MangoStudio's own precondition. Codex would complete the review instead
    // of failing — it logs `fatal: not a git repository` internally and reviews
    // nothing — so this test is what keeps the check from being deleted as
    // redundant.
    const { stream, runtime } = reviewHarness({ repoRoot: () => null });

    const result = await stream(reviewInput(), getDb());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('review-requires-git');
    expect(runtime.calls.startReview).toHaveLength(0);
  });

  it('asks the machine that owns the workspace, using the canonical path', async () => {
    // Not the hub's filesystem: the workspace may be on an SSH host, in a
    // container, in WSL or on a paired machine, and a hub-side check would be
    // answering about the wrong disk.
    const { stream, repoRootCalls } = reviewHarness();

    const result = await stream(reviewInput(), getDb());
    expect(result.ok).toBe(true);
    expect(repoRootCalls).toEqual([
      { workdir: '/work/repo', selection: { userId, environmentId: 'local' } },
    ]);
  });

  it('reports an unreachable machine as unavailable rather than as no repository', async () => {
    const { stream } = reviewHarness({ repoRootFailure: () => new Error('runtime is gone') });

    const result = await stream(reviewInput(), getDb());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unavailable');
  });

  it('refuses a runner whose descriptor reports no nativeReview', async () => {
    const { stream, repoRootCalls } = harness();

    const result = await stream(reviewInput(), getDb());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unsupported');
    // Refused before the round trip: an agent that cannot review has no reason
    // to make the hub ask another machine about Git.
    expect(repoRootCalls).toHaveLength(0);
  });

  it('never checks Git for an ordinary send, even by an agent that could review', async () => {
    const { stream, repoRootCalls, runtime } = reviewHarness();
    const result = await stream(
      {
        userId,
        chat: chatRecord(),
        chatId,
        prompt: 'hello',
        attachmentIds: [],
        externalTurn: undefined,
      },
      getDb()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'completed' });
    await readChunks(result.response);

    expect(repoRootCalls).toHaveLength(0);
  });

  it('refuses a review whose chat moved while preflight was awaiting', async () => {
    const { stream, runtime } = reviewHarness({
      repoRoot: async () => {
        await getDb()
          .updateTable('chats')
          .set({ workdir: '/work/other' })
          .where('id', '=', chatId)
          .execute();
        return '/work/repo';
      },
    });

    const result = await stream(reviewInput(), getDb());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('conflict');
    expect(runtime.calls.startReview).toHaveLength(0);
  });
});

/**
 * What the vendor wire can carry, decided before the response is committed.
 *
 * `ExternalAgentTurnParamsSchema` takes at most four attachments of at most
 * `EXTERNAL_ATTACHMENT_MAX_BYTES` each, while a chat attachment may be 20 MB and
 * a turn may name twenty of them. Without a check on this side the runtime
 * raises the refusal instead — after the 200 is already a stream, so a turn the
 * user is watching dies with a message about an invalid payload.
 */
describe('attachments the vendor wire cannot carry', () => {
  const IMAGE_CAPABILITIES: ExternalAgentCapabilities = {
    ...NO_EXTERNAL_AGENT_CAPABILITIES,
    structuredStreaming: true,
    images: true,
  };

  function imageHarness() {
    return harness({
      agents: [descriptor({ capabilities: IMAGE_CAPABILITIES })],
      sessionCapabilities: IMAGE_CAPABILITIES,
    });
  }

  /**
   * The acknowledgement is fingerprinted over the capability set the user was
   * shown, and the disclosure gate runs *before* the attachments are read — so
   * a case here that does not acknowledge the exact descriptor it sends against
   * asserts the disclosure refusal instead of the attachment one.
   */
  function acknowledge(capabilities: ExternalAgentCapabilities): Promise<unknown> {
    return acknowledgeExternalDisclosure(
      { userId, targetId: 'codex' },
      { capabilities, supportedConfigurations: EVERY_PAIR },
      getDb()
    );
  }

  beforeEach(() => acknowledge(IMAGE_CAPABILITIES));

  async function insertAttachment(
    overrides: { kind?: ChatAttachmentKind; sizeBytes?: number } = {}
  ): Promise<string> {
    const id = crypto.randomUUID();
    await getDb()
      .insertInto('chat_attachments')
      .values({
        id,
        userId,
        chatId,
        messageId: null,
        originalName: 'shot.png',
        storedName: `${id}-shot.png`,
        relativePath: `${chatId}/${id}-shot.png`,
        url: `/uploads/${chatId}/${id}-shot.png`,
        mimeType: 'image/png',
        sizeBytes: overrides.sizeBytes ?? 1024,
        kind: overrides.kind ?? 'image',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();
    return id;
  }

  function sendWith(attachmentIds: readonly string[]) {
    return {
      userId,
      chat: chatRecord(),
      chatId,
      prompt: 'what is in this picture',
      attachmentIds,
      externalTurn: undefined,
    };
  }

  /**
   * A target that cannot read an image refuses the send rather than stripping
   * it. Dropping it silently would let the user watch the agent answer
   * confidently about a picture it never received — the one outcome worse than
   * not sending at all.
   *
   * Refused in preflight, so it is a request error rather than a stream that
   * opens and then dies.
   */
  it('refuses an attachment for a target that cannot read one', async () => {
    // The plain descriptor, so this is the only case here that acknowledges a
    // capability set without `images`.
    await acknowledge(descriptor().capabilities);
    const { stream } = harness();

    const result = await stream(sendWith(['attachment-1']), getDb());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unsupported');
    expect(result.failure.message).toMatch(/cannot read attachments/i);
  });

  it('refuses more attachments than the turn schema accepts', async () => {
    const { stream } = imageHarness();
    const ids = await Promise.all(Array.from({ length: 5 }, () => insertAttachment()));

    const result = await stream(sendWith(ids), getDb());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('validation');
    expect(result.failure.message).toContain(String(EXTERNAL_TURN_MAX_ATTACHMENTS));
  });

  it('refuses an attachment larger than the turn schema accepts', async () => {
    const { stream } = imageHarness();
    const id = await insertAttachment({ sizeBytes: EXTERNAL_ATTACHMENT_MAX_BYTES + 1 });

    const result = await stream(sendWith([id]), getDb());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('validation');
    expect(result.failure.message).toMatch(/under 2 MB/i);
  });

  /**
   * A kind no adapter maps is refused, never dropped.
   *
   * Codex maps every attachment it is handed as an image regardless of kind, so
   * a PDF would arrive as a broken picture; filtering it out instead would let
   * the agent answer confidently about a document it never received.
   */
  it('refuses a kind the vendor wire cannot carry rather than dropping it', async () => {
    const { stream } = imageHarness();
    const id = await insertAttachment({ kind: 'text' });

    const result = await stream(sendWith([id]), getDb());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unsupported');
    expect(result.failure.message).toMatch(/only take image attachments/i);
  });

  /**
   * An id this chat does not own is the user's request being wrong, so it keeps
   * the sentence about the upload.
   */
  it('blames the upload for an attachment this chat does not own', async () => {
    const { stream } = imageHarness();

    const result = await stream(sendWith([crypto.randomUUID()]), getDb());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('validation');
    expect(result.failure.message).toMatch(/could not be read/i);
  });

  /**
   * A database that is down is not the file being wrong.
   *
   * Blaming it on the upload sends the user to re-attach a file that was never
   * the problem, and says nothing to whoever has to find out why the machine
   * stopped answering — so it follows `configuration_unresolved`: logged, and
   * `unavailable`.
   */
  it('does not blame the upload for a failure that is not about one', async () => {
    const { stream } = imageHarness();
    const id = await insertAttachment();

    const result = await stream(
      sendWith([id]),
      new UnreadableAttachmentsDb(getDb(), new Error('database is locked')).asDb()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unavailable');
    expect(result.failure.message).not.toMatch(/could not be read/i);
  });
});

/**
 * A database whose attachment read fails the way an unreachable disk or a
 * dropped connection does: an ordinary error, not one of the two named
 * refusals that are actually about an upload.
 *
 * Only `chat_attachments` fails, so everything the preflight does before
 * reaching the attachments still runs against the real database.
 */
class UnreadableAttachmentsDb {
  constructor(
    private readonly inner: Kysely<Database>,
    private readonly failure: Error
  ) {}

  asDb(): Kysely<Database> {
    return new Proxy(this.inner, {
      get: (target, property, receiver) => {
        if (property === 'selectFrom') {
          return (table: keyof Database) => {
            if (table === 'chat_attachments') throw this.failure;
            return target.selectFrom(table);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Kysely<Database>;
  }
}
