/**
 * The lifecycle of one external agent session, from the hub's side.
 *
 * A session is the vendor's conversation. It outlives a turn, so its identity,
 * its ordering cursor and its continuation row all live here rather than on the
 * turn that happens to be running. What the turn controller gets back is a
 * handle: the calls it may make against this session, and one place events
 * arrive already ordered.
 *
 * Three properties this module exists to hold:
 *
 * - **One vendor session per chat.** Two simultaneous sends must not open two.
 *   A per-chat promise collapses the burst, and the continuation row's primary
 *   key is what makes it true rather than likely.
 * - **A continuation is only valid for its binding.** Environment, target,
 *   canonical workspace and vendor account are part of the session's identity;
 *   a change to any of them starts fresh and says so. Permission level and
 *   approval routing are not — the vendors accept those per turn, so restarting
 *   on a permission change would be a regression.
 * - **Nothing outlives its reason to exist.** Chat deletion, an environment
 *   change, a dropped runtime, a withdrawn consent and hub shutdown each close
 *   the session and tell the live turn why, instead of leaving a vendor process
 *   running for a conversation that is gone.
 */

import type { ToolchainSelection } from '@mangostudio/shared/environments';
import type {
  ExternalAgentAttachment,
  ExternalAgentCapabilities,
  ExternalAgentConfiguration,
  ExternalAgentEventEnvelope,
  ExternalAgentSteerResult,
  ExternalAgentTargetId,
  ExternalReviewTarget,
  ExternalTurnTerminalReason,
} from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRuntimeClient, type RuntimeClient } from '../../../services/runtime-client';
import { generateId } from '../../../utils/id';
import {
  resolveToolchainParams,
  toolchainService,
} from '../../environments/application/toolchain-service';
import {
  type ExternalEnvelopeVerdict,
  ExternalEventSequencer,
} from '../domain/external-event-sequencer';
import {
  EXTERNAL_ADOPTION_LEASE_TTL_MS,
  refreshAdoptionLease,
  releaseAdoptionLease,
} from '../infrastructure/external-session-adoption-lease-repository';
import {
  continuationMatches,
  deleteContinuation,
  readContinuation,
  writeContinuation,
} from '../infrastructure/external-session-continuation-repository';

const logger = createDiagnosticLogger('external-session-manager');

/** Long enough for a cold vendor start on a remote machine, short enough to fail a send. */
const OPEN_TIMEOUT_MS = 60_000;
/** The turn call only registers the turn; the events that follow are unbounded by it. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * The chat's session was reaped while it was being opened — its consent, its
 * chat or its environment changed under the open. The caller has to fail the
 * send rather than run against a session nobody asked for.
 */
export class ExternalSessionReapedError extends Error {
  constructor(chatId: string) {
    super(`The external session for chat "${chatId}" was closed while it was opening.`);
    this.name = 'ExternalSessionReapedError';
  }
}

/** Everything a stored continuation is only valid for. */
interface ExternalSessionBinding {
  readonly userId: string;
  readonly chatId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly canonicalWorkspacePath: string;
  /** Absent when the adapter reported no account identity to compare. */
  readonly vendorAccountFingerprint: string | null;
  /**
   * The attested credential home behind this environment's vendor logins.
   *
   * Part of the binding, so a session opened against one OS identity is never
   * resumed against another. Null only on rows written before the attestation
   * existed; a live session cannot reach here without one, because the turn
   * controller refuses to start without an attestation.
   */
  readonly credentialHomeFingerprint: string | null;
}

export interface EnsureExternalSessionInput extends ExternalSessionBinding {
  readonly configuration: ExternalAgentConfiguration;
}

/** What arrives on the session's event topic, already ordered and deduplicated. */
export interface ExternalSessionConsumer {
  onEnvelope(envelope: ExternalAgentEventEnvelope, verdict: ExternalEnvelopeVerdict): void;
  /** The session went away for a reason the turn has to record. */
  onTeardown(reason: ExternalTurnTerminalReason): void;
}

/**
 * The calls a turn may make against one session, plus its ordered event feed.
 *
 * The handle is deliberately narrower than the runtime client: it cannot open,
 * discover or address another session, so a turn holding one cannot reach past
 * the conversation it was started for.
 */
export interface ExternalSessionHandle {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly resumed: boolean;
  readonly fallbackReason?: string;
  readonly effectiveConfiguration: ExternalAgentConfiguration;
  readonly capabilities: ExternalAgentCapabilities;
  /** Replaces any previous consumer; one turn runs on a session at a time. */
  subscribe(consumer: ExternalSessionConsumer): () => void;
  beginTurn(nativeTurnId: string): void;
  endTurn(nativeTurnId: string): void;
  startTurn(input: {
    readonly clientMessageId: string;
    readonly input: string;
    readonly configuration: ExternalAgentConfiguration;
    readonly attachments?: readonly ExternalAgentAttachment[];
  }): Promise<string>;
  respond(input: {
    readonly nativeTurnId: string;
    readonly requestId: string;
    readonly optionId: string;
  }): Promise<void>;
  steer(input: {
    readonly nativeTurnId: string;
    readonly clientMessageId: string;
    readonly text: string;
  }): Promise<ExternalAgentSteerResult>;
  /**
   * Starts a vendor-native review as this session's turn.
   *
   * Returns the same `nativeTurnId` an ordinary turn does, plus the thread the
   * vendor ran the review on. Both are persisted by the caller: inline delivery
   * puts the review on this session's own thread, and a value that disagrees is
   * a turn whose events would never be correlated.
   *
   * The current runner configuration is not sent. A review inherits the
   * sandbox, approval policy and model this session was opened with; a later
   * permission change takes effect on the next ordinary turn, not by
   * reconfiguring this one.
   */
  startReview(input: {
    readonly clientMessageId: string;
    readonly target: ExternalReviewTarget;
  }): Promise<{ readonly nativeTurnId: string; readonly reviewThreadId: string }>;
  cancel(nativeTurnId?: string): Promise<void>;
}

export interface ExternalSessionManager {
  ensureSession(input: EnsureExternalSessionInput): Promise<ExternalSessionHandle>;
  /**
   * Closes the chat's session and tells its live turn why. `keepContinuation`
   * decides whether the vendor conversation can still be resumed afterwards —
   * a dropped runtime can, a changed binding cannot.
   */
  reapChat(
    chatId: string,
    reason: ExternalTurnTerminalReason,
    options?: { readonly keepContinuation?: boolean }
  ): Promise<void>;
  /**
   * Reaps every session matching a scope. Used by consent, environment and user
   * changes.
   *
   * Every field narrows; an omitted one matches everything. `targetId` exists
   * because a disclosure is withdrawn from *one vendor*: without it, refusing
   * Anthropic would also kill the OpenAI turn running in the next tab, which is
   * a different company's consent that nobody withdrew.
   */
  reapScope(
    scope: {
      readonly userId?: string;
      readonly environmentId?: string;
      readonly targetId?: ExternalAgentTargetId;
    },
    reason: ExternalTurnTerminalReason,
    options?: { readonly keepContinuation?: boolean }
  ): Promise<void>;
  reapAll(reason: ExternalTurnTerminalReason): Promise<void>;
  liveSessionCount(): number;
}

export interface ExternalSessionManagerOptions {
  readonly resolveRuntimeClient?: (userId: string, environmentId: string) => Promise<RuntimeClient>;
  readonly resolveToolchain?: (
    userId: string,
    environmentId: string
  ) => Promise<ToolchainSelection>;
  readonly db?: () => Kysely<Database>;
  readonly now?: () => number;
  readonly newSessionId?: () => string;
  readonly openTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

interface OpenedSession {
  readonly nativeSessionId: string;
  readonly resumed: boolean;
  readonly fallbackReason?: string;
  readonly effectiveConfiguration: ExternalAgentConfiguration;
  readonly capabilities: ExternalAgentCapabilities;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly binding: ExternalSessionBinding;
  readonly client: RuntimeClient;
  readonly sequencer: ExternalEventSequencer;
  readonly open: OpenedSession;
  unsubscribe: () => void;
  consumer?: ExternalSessionConsumer;
  closing: boolean;
}

function sameBinding(left: ExternalSessionBinding, right: ExternalSessionBinding): boolean {
  return (
    left.userId === right.userId &&
    left.environmentId === right.environmentId &&
    left.targetId === right.targetId &&
    left.canonicalWorkspacePath === right.canonicalWorkspacePath &&
    left.vendorAccountFingerprint === right.vendorAccountFingerprint &&
    left.credentialHomeFingerprint === right.credentialHomeFingerprint
  );
}

export function createExternalSessionManager(
  options: ExternalSessionManagerOptions = {}
): ExternalSessionManager {
  const resolveRuntimeClient = options.resolveRuntimeClient ?? getRuntimeClient;
  const resolveToolchain =
    options.resolveToolchain ??
    ((userId: string, environmentId: string) => toolchainService.resolve(userId, environmentId));
  const resolveDb = options.db ?? getDb;
  const now = options.now ?? Date.now;
  const newSessionId = options.newSessionId ?? generateId;
  const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;

  const sessions = new Map<string, SessionRecord>();
  /**
   * The single-flight. It is an optimization over the primary key, not a
   * substitute for it: it collapses one hub's concurrent sends into one open,
   * while the continuation row is what guarantees a chat never ends up
   * remembering two vendor sessions.
   */
  const opening = new Map<
    string,
    { readonly promise: Promise<ExternalSessionHandle>; readonly binding: ExternalSessionBinding }
  >();
  /**
   * Bumped by every reap. An open is slow — it starts a process on someone
   * else's machine — and a consent revocation or a chat deletion landing while
   * one is in flight would otherwise register the session it was told not to
   * have. Comparing the generation across the await is what closes that.
   */
  const reapGenerations = new Map<string, number>();

  function handleFor(record: SessionRecord): ExternalSessionHandle {
    return {
      sessionId: record.sessionId,
      nativeSessionId: record.open.nativeSessionId,
      targetId: record.binding.targetId,
      resumed: record.open.resumed,
      ...(record.open.fallbackReason ? { fallbackReason: record.open.fallbackReason } : {}),
      effectiveConfiguration: record.open.effectiveConfiguration,
      capabilities: record.open.capabilities,
      subscribe(consumer) {
        record.consumer = consumer;
        return () => {
          if (record.consumer === consumer) record.consumer = undefined;
        };
      },
      beginTurn(nativeTurnId) {
        record.sequencer.beginTurn(nativeTurnId);
      },
      endTurn(nativeTurnId) {
        record.sequencer.endTurn(nativeTurnId);
      },
      async startTurn(input) {
        const result = await record.client.externalAgents.turn(
          {
            sessionId: record.sessionId,
            clientMessageId: input.clientMessageId,
            input: input.input,
            configuration: input.configuration,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          },
          { timeoutMs: callTimeoutMs }
        );
        return result.nativeTurnId;
      },
      async respond(input) {
        await record.client.externalAgents.respond(
          {
            sessionId: record.sessionId,
            nativeTurnId: input.nativeTurnId,
            requestId: input.requestId,
            optionId: input.optionId,
          },
          { timeoutMs: callTimeoutMs }
        );
      },
      async steer(input) {
        return await record.client.externalAgents.steer(
          {
            sessionId: record.sessionId,
            nativeTurnId: input.nativeTurnId,
            clientMessageId: input.clientMessageId,
            input: input.text,
          },
          { timeoutMs: callTimeoutMs }
        );
      },
      async startReview(input) {
        // No `configuration`: Codex `review/start` has none, and a review must
        // not reopen the session to apply a newer sandbox. The thread's
        // existing policy is the one the user already accepted for this chat.
        return await record.client.externalAgents.startReview(
          {
            sessionId: record.sessionId,
            clientMessageId: input.clientMessageId,
            target: input.target,
          },
          { timeoutMs: callTimeoutMs }
        );
      },
      async cancel(nativeTurnId) {
        await record.client.externalAgents.cancel(
          { sessionId: record.sessionId, ...(nativeTurnId ? { nativeTurnId } : {}) },
          { timeoutMs: callTimeoutMs }
        );
      },
    };
  }

  function teardown(chatId: string, reason: ExternalTurnTerminalReason): SessionRecord | undefined {
    const record = sessions.get(chatId);
    if (!record) return undefined;
    sessions.delete(chatId);
    record.closing = true;
    record.unsubscribe();
    // The turn is told before the vendor call, so a slow close cannot leave the
    // transcript spinning while the session is already gone.
    record.consumer?.onTeardown(reason);
    record.consumer = undefined;
    return record;
  }

  async function closeRemote(record: SessionRecord): Promise<void> {
    try {
      await record.client.externalAgents.close(
        { sessionId: record.sessionId },
        { timeoutMs: callTimeoutMs }
      );
    } catch (error) {
      // A runtime that is already gone cannot be asked to close anything, and
      // reaping must not fail because of it.
      logger.warn('session_close_failed', {
        sessionId: record.sessionId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  async function reap(
    chatId: string,
    reason: ExternalTurnTerminalReason,
    keepContinuation: boolean
  ): Promise<void> {
    reapGenerations.set(chatId, (reapGenerations.get(chatId) ?? 0) + 1);
    const record = teardown(chatId, reason);
    if (!keepContinuation) {
      // The lease goes with the pointer it protects. Keeping it would leave the
      // vendor session unadoptable by anyone until it expired, on behalf of a
      // chat that is no longer attached to it.
      await deleteContinuation(chatId, resolveDb());
      await releaseAdoptionLease(chatId, resolveDb());
    }
    if (record) await closeRemote(record);
  }

  async function openSession(input: EnsureExternalSessionInput): Promise<ExternalSessionHandle> {
    const db = resolveDb();
    const binding: ExternalSessionBinding = {
      userId: input.userId,
      chatId: input.chatId,
      environmentId: input.environmentId,
      targetId: input.targetId,
      canonicalWorkspacePath: input.canonicalWorkspacePath,
      vendorAccountFingerprint: input.vendorAccountFingerprint,
      credentialHomeFingerprint: input.credentialHomeFingerprint,
    };

    const generation = reapGenerations.get(input.chatId) ?? 0;
    const stored = await readContinuation(input.chatId, db);
    // A stale binding is dropped before the open, not after: resuming against
    // another environment's session id would hand one binding's conversation to
    // a different one.
    const resumable = stored && continuationMatches(stored, binding) ? stored : undefined;
    if (stored && !resumable) {
      await deleteContinuation(input.chatId, db);
      await releaseAdoptionLease(input.chatId, db);
    }

    const client = await resolveRuntimeClient(input.userId, input.environmentId);
    const toolchain = await resolveToolchainParams(client.manifest, () =>
      resolveToolchain(input.userId, input.environmentId)
    );
    const sessionId = newSessionId();
    const opened = await client.externalAgents.open(
      {
        sessionId,
        targetId: input.targetId,
        workspacePath: input.canonicalWorkspacePath,
        configuration: input.configuration,
        ...(resumable ? { resumeRef: resumable.nativeSessionId } : {}),
        // The ordinary turn path wants a conversation, not a failure, when the
        // vendor has forgotten the session — but an adopted one is the opposite
        // case. The user picked *that* conversation by name, so its first open
        // fails rather than silently handing back an empty one; every open
        // after the vendor confirms the resume is an ordinary turn again.
        resumeMode: resumable?.pendingAdoption ? 'strict' : 'fallback',
        timeoutMs: openTimeoutMs,
        ...toolchain,
      },
      { timeoutMs: openTimeoutMs }
    );

    const sequencer = new ExternalEventSequencer();
    const record: SessionRecord = {
      sessionId,
      binding,
      client,
      sequencer,
      open: {
        nativeSessionId: opened.nativeSessionId,
        // A resume that fell back opened a fresh conversation, whatever the row
        // said. Reporting the vendor's own answer is what lets the UI say so.
        resumed: opened.resumed,
        ...(opened.fallbackReason ? { fallbackReason: opened.fallbackReason } : {}),
        effectiveConfiguration: opened.effectiveConfiguration,
        capabilities: opened.capabilities,
      },
      unsubscribe: () => undefined,
      closing: false,
    };

    const unsubscribeEvents = client.externalAgents.onEvent(sessionId, (envelope) => {
      const verdict = sequencer.admit(envelope);
      record.consumer?.onEnvelope(envelope, verdict);
    });
    const unsubscribeClose = client.onClose(() => {
      if (record.closing) return;
      // The vendor conversation may well survive the socket, so the row stays
      // and the next send resumes it.
      void reap(input.chatId, 'runtime-disconnected', true).catch(() => undefined);
    });
    record.unsubscribe = () => {
      unsubscribeEvents();
      unsubscribeClose();
    };

    await writeContinuation(
      {
        ...binding,
        chatId: input.chatId,
        runtimeSessionId: sessionId,
        nativeSessionId: opened.nativeSessionId,
        effectiveConfiguration: opened.effectiveConfiguration,
        updatedAt: now(),
        // Cleared by the vendor's own confirmation, not by having tried: a
        // strict open that did not resume never reaches here, and one that did
        // has nothing left to be strict about.
        pendingAdoption: resumable?.pendingAdoption === true && !opened.resumed,
      },
      db
    );
    // A chat that is still opening sessions is still using the conversation it
    // adopted, so the claim is renewed by use rather than by a timer. Scoped to
    // this chat, so a lease that expired and was taken over cannot be reclaimed
    // by continuing to send.
    if (resumable) {
      await refreshAdoptionLease(input.chatId, now() + EXTERNAL_ADOPTION_LEASE_TTL_MS, db);
    }

    // Checked after the last await and registered on the same tick, so a reap
    // that landed while the vendor was starting cannot be followed by the row it
    // just deleted, or by a session the owner has already refused.
    if ((reapGenerations.get(input.chatId) ?? 0) !== generation) {
      record.unsubscribe();
      await deleteContinuation(input.chatId, db);
      await client.externalAgents
        .close({ sessionId }, { timeoutMs: callTimeoutMs })
        .catch(() => undefined);
      throw new ExternalSessionReapedError(input.chatId);
    }
    sessions.set(input.chatId, record);

    return handleFor(record);
  }

  async function ensureSession(input: EnsureExternalSessionInput): Promise<ExternalSessionHandle> {
    const live = sessions.get(input.chatId);
    if (live && !live.closing) {
      if (sameBinding(live.binding, input)) return handleFor(live);
      // The live session belongs to a binding this chat no longer has. Closing
      // it here is what keeps a vendor process from outliving the environment,
      // workspace or account that justified it.
      await reap(input.chatId, 'session-lost', false);
    }
    return openSession(input);
  }

  return {
    ensureSession(input) {
      // Shared only with a send that wants the same session. A concurrent send
      // whose binding differs would otherwise be handed a session opened against
      // another environment, workspace or account, so it waits for the open to
      // settle and then takes the ordinary path, which reaps and reopens.
      const inflight = opening.get(input.chatId);
      if (inflight) {
        return sameBinding(inflight.binding, input)
          ? inflight.promise
          : inflight.promise.catch(() => undefined).then(() => this.ensureSession(input));
      }

      const pending = ensureSession(input).finally(() => {
        if (opening.get(input.chatId)?.promise === pending) opening.delete(input.chatId);
      });
      opening.set(input.chatId, { promise: pending, binding: input });
      return pending;
    },

    reapChat(chatId, reason, reapOptions) {
      return reap(chatId, reason, reapOptions?.keepContinuation === true);
    },

    async reapScope(scope, reason, reapOptions) {
      const inScope = (binding: ExternalSessionBinding): boolean =>
        (!scope.userId || binding.userId === scope.userId) &&
        (!scope.environmentId || binding.environmentId === scope.environmentId) &&
        (!scope.targetId || binding.targetId === scope.targetId);

      const chatIds = new Set<string>();
      for (const [chatId, record] of sessions) {
        if (inScope(record.binding)) chatIds.add(chatId);
      }
      // A session still opening is not in `sessions` yet, and skipping it would
      // let the open register a vendor process for a consent, environment or
      // user that has already been revoked. Reaping by chat id bumps the
      // generation the open re-reads after its last await, so it closes what it
      // started instead.
      for (const [chatId, inflight] of opening) {
        if (inScope(inflight.binding)) chatIds.add(chatId);
      }

      await Promise.all(
        [...chatIds].map((chatId) => reap(chatId, reason, reapOptions?.keepContinuation === true))
      );
    },

    async reapAll(reason) {
      // Concurrently: each close can spend the full call timeout on a runtime
      // that stopped answering, and serializing them would add that to shutdown
      // once per chat while later vendor processes have not been asked to stop.
      await Promise.all(
        // Shutdown keeps continuation: the vendor conversation is still the one
        // this chat resumes when the hub comes back.
        [...sessions.keys()].map((chatId) => reap(chatId, reason, true))
      );
    },

    liveSessionCount() {
      return sessions.size;
    },
  };
}

/** The hub's session manager. One per process. */
export const externalSessionManager = createExternalSessionManager();
