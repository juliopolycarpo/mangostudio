/**
 * One external turn, from the send that started it to its terminal state.
 *
 * Everything a later feature needs is decided here once: identity, single-flight
 * session creation, ordered and deduplicated event delivery, incremental
 * persistence, approval binding, cancellation and what happens after every kind
 * of disconnect. Steering, usage, reconnect and session adoption all read the
 * same envelope and the same transcript, so none of them has to invent its own
 * ordering rules.
 *
 * What this module deliberately does **not** do, and what the boundary tests
 * hold it to:
 *
 * 0. It never satisfies a vendor's request to run a tool. There is no path from
 *    an external event to executing anything — the neutral event contract has no
 *    member that could carry such a request, and the adapter refuses it before
 *    it reaches the hub.
 * 1. No tool executor. An external turn never calls `executeTool` and never
 *    touches the tool registry.
 * 2. No MangoStudio tool definitions cross to the vendor. The turn parameters
 *    are a closed schema with nowhere to put one.
 * 3. No permission engine. `restrictToolsToWorkdir`, tool settings and path
 *    policy are not evaluated: the vendor decides, MangoStudio relays.
 * 4. No budget. The agentic iteration limits do not apply; the vendor owns its
 *    loop, and only the byte and event caps bound it.
 * 5. Credential blindness. No vendor credential file is read and no MangoStudio
 *    connector secret is forwarded.
 * 6. No cross-user reuse. A session belongs to one user, and its continuation is
 *    only valid for the binding it was opened under.
 * 7. No mixed ownership. A chat whose runner is `mangostudio` cannot run an
 *    external turn, and the converse is enforced where internal turns start.
 */

import { RuntimeConsentDeniedError } from '@mangostudio/runtime';
import type { InteractionMode } from '@mangostudio/shared';
import type {
  ExternalAgentConfiguration,
  ExternalAgentError,
  ExternalAgentEvent,
  ExternalAgentTargetId,
  ExternalApprovalRequest,
  ExternalTurnTerminalReason,
  ExternalUsage,
} from '@mangostudio/shared/external-agents';
import type { TurnInterruptionReasonCode } from '@mangostudio/shared/turn-recovery';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { generateId } from '../../../utils/id';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import {
  type ActiveExternalTurn,
  findActiveTurnByChat,
  registerActiveTurn,
  unregisterActiveTurn,
} from '../../generation/application/active-turn-registry';
import {
  CHECKPOINT_MAX_INTERVAL_MS,
  CHECKPOINT_TEXT_INTERVAL_CHARS,
} from '../../generation/application/turn-checkpoint';
import {
  finalizeCheckpointedAiResponse,
  persistTextTurnStart,
  updateChatAfterTurn,
} from '../../generation/infrastructure/conversation-persistence';
import { ExternalTurnTranscript } from '../domain/external-turn-transcript';
import {
  type AnswerExternalApprovalResult,
  type ExternalApprovalRegistry,
  externalApprovalRegistry,
} from './external-approval-registry';
import {
  type ExternalSessionHandle,
  type ExternalSessionManager,
  externalSessionManager,
} from './external-session-manager';

const logger = createDiagnosticLogger('external-turn-controller');

/** External turns are agent-shaped in every place that already branches on mode. */
const EXTERNAL_INTERACTION_MODE: Exclude<InteractionMode, 'image'> = 'agent';

/** A second send arrived while this chat already had a live turn. */
export class ExternalTurnConflictError extends Error {
  constructor(chatId: string) {
    super(`Chat "${chatId}" already has a turn in progress.`);
    this.name = 'ExternalTurnConflictError';
  }
}

/** The chat is not configured for the external runner this turn would use. */
export class ExternalTurnRunnerMismatchError extends Error {
  constructor(chatId: string, reason: string) {
    super(`Chat "${chatId}" cannot run an external turn: ${reason}`);
    this.name = 'ExternalTurnRunnerMismatchError';
  }
}

/** An external turn needs a workspace; there is nothing for the vendor to run against without one. */
export class ExternalTurnWorkspaceMissingError extends Error {
  constructor(chatId: string) {
    super(`Chat "${chatId}" has no workspace directory for an external agent to run in.`);
    this.name = 'ExternalTurnWorkspaceMissingError';
  }
}

/**
 * Live delivery for a caller that is rendering the turn.
 *
 * This PR has no SSE route; the observer is how one is wired without the
 * controller having to know about transports. Only events that were applied to
 * the transcript are reported, so a client and a reloaded transcript can never
 * disagree about what happened.
 */
interface ExternalTurnObserver {
  onSession?(session: {
    readonly sessionId: string;
    readonly targetId: ExternalAgentTargetId;
    readonly resumed: boolean;
    readonly fallbackReason?: string;
  }): void;
  onEvent?(event: ExternalAgentEvent): void;
  onTerminal?(reason: ExternalTurnTerminalReason, error?: ExternalAgentError): void;
}

interface StartExternalTurnInput {
  readonly userId: string;
  readonly chatId: string;
  readonly prompt: string;
  readonly attachmentIds?: readonly string[];
  readonly configuration: ExternalAgentConfiguration;
  /**
   * The workspace as the runtime canonicalized it. Server-resolved: a
   * client-supplied path would be the vendor's working directory.
   */
  readonly canonicalWorkspacePath: string;
  /** From discovery; absent when the adapter reported no account identity. */
  readonly vendorAccountFingerprint?: string | null;
  readonly observer?: ExternalTurnObserver;
}

export interface ExternalTurnResult {
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly sessionId: string;
  readonly nativeTurnId?: string;
  readonly reason: ExternalTurnTerminalReason;
  readonly usage?: ExternalUsage;
  readonly error?: ExternalAgentError;
}

export interface ExternalTurnControllerDependencies {
  readonly sessions?: ExternalSessionManager;
  readonly approvals?: ExternalApprovalRegistry;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * How an abort from the shared registry reads as an external terminal state.
 *
 * The stop button sends `user_cancelled`; the shutdown path sends
 * `server_restart`. Everything else is an abort whose origin the registry does
 * not name, and calling that a user cancellation would put a claim in the
 * transcript that nobody made.
 */
function terminalReasonForAbort(
  reasonCode: TurnInterruptionReasonCode
): ExternalTurnTerminalReason {
  switch (reasonCode) {
    case 'user_cancelled':
      return 'cancelled-by-user';
    case 'server_restart':
      return 'hub-restarted';
    case 'provider_error':
      return 'vendor-error';
    default:
      return 'runtime-disconnected';
  }
}

/**
 * How a failed call against a live session reads as a terminal state.
 *
 * `session-lost` comes from an argument refusal because the session id is the
 * only argument the hub chose: the rest of the call is schema-validated before
 * it is dispatched, so an argument the runtime rejects is the session it no
 * longer has.
 */
function terminalReasonForCallFailure(error: unknown): ExternalTurnTerminalReason {
  if (error instanceof RuntimeConsentDeniedError) return 'consent-revoked';
  if (error instanceof Error && error.name === 'ToolArgumentError') return 'session-lost';
  return 'vendor-error';
}

function vendorErrorFrom(error: unknown, code: string): ExternalAgentError {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return { code, message: message.slice(0, 2_048) };
}

/**
 * Serializes the incremental writes for one assistant row.
 *
 * Same cadence as the internal turn — a character interval and a time interval,
 * with forced writes at durable boundaries — so a dropped connection leaves a
 * readable prefix rather than an empty message, and a delta stream does not turn
 * into one write per token.
 */
class ExternalTranscriptWriter {
  #lastTextLength = 0;
  #lastWrittenAt: number;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly messageId: string,
    private readonly transcript: ExternalTurnTranscript,
    private readonly now: () => number
  ) {
    this.#lastWrittenAt = now();
  }

  write(options: { readonly force?: boolean } = {}): Promise<void> {
    const at = this.now();
    const text = this.transcript.text;
    if (options.force !== true && !this.#shouldWrite(text.length, at)) return this.#pending;

    this.#lastTextLength = text.length;
    this.#lastWrittenAt = at;
    const parts = JSON.stringify(this.transcript.parts);
    this.#pending = this.#pending
      .then(() =>
        this.db
          .updateTable('messages')
          .set({ text, parts })
          .where('id', '=', this.messageId)
          .where('isGenerating', '=', 1)
          .execute()
      )
      .then(
        () => undefined,
        (error: unknown) => {
          // Best effort, exactly like the internal turn's checkpoint writer: a
          // transient database error must neither abort the live turn nor
          // reject every write chained behind it.
          logger.warn('checkpoint_write_failed', {
            messageId: this.messageId,
            error: String(error),
          });
        }
      );
    return this.#pending;
  }

  flush(): Promise<void> {
    return this.#pending;
  }

  #shouldWrite(textLength: number, at: number): boolean {
    return (
      textLength - this.#lastTextLength >= CHECKPOINT_TEXT_INTERVAL_CHARS ||
      at - this.#lastWrittenAt >= CHECKPOINT_MAX_INTERVAL_MS
    );
  }
}

export interface ExternalTurnController {
  start(input: StartExternalTurnInput, db: Kysely<Database>): Promise<ExternalTurnResult>;
  /**
   * Answers a pending approval. Delegates the whole decision to the registry —
   * a caller cannot reach the vendor without passing its five-way binding,
   * option, expiry and idempotency checks.
   *
   * `sessionId` and `nativeTurnId` are server-owned and optional for the reason
   * the registry states: a caller that knows them (a live stream does, and so
   * does anything reading the persisted `external_turn` record) gets them
   * checked, which is what stops a delayed answer from a previous card matching
   * a later turn that reused its request id.
   */
  answerApproval(input: {
    readonly userId: string;
    readonly chatId: string;
    readonly requestId: string;
    readonly optionId: string;
    readonly sessionId?: string;
    readonly nativeTurnId?: string;
  }): Promise<AnswerExternalApprovalResult>;
}

export function createExternalTurnController(
  dependencies: ExternalTurnControllerDependencies = {}
): ExternalTurnController {
  const sessions = dependencies.sessions ?? externalSessionManager;
  const approvals = dependencies.approvals ?? externalApprovalRegistry;
  const now = dependencies.now ?? Date.now;
  const newId = dependencies.newId ?? generateId;
  /**
   * The transcript of each chat's live turn, so an answered approval reaches the
   * durable record without waiting for the vendor to echo it back. One entry per
   * chat, because a chat holds one turn at a time.
   */
  const liveTurns = new Map<
    string,
    { readonly transcript: ExternalTurnTranscript; readonly writer: ExternalTranscriptWriter }
  >();

  async function start(
    input: StartExternalTurnInput,
    db: Kysely<Database>
  ): Promise<ExternalTurnResult> {
    const chat = await getOwnedChat(input.chatId, input.userId, db);
    if (!chat) throw new ExternalTurnRunnerMismatchError(input.chatId, 'chat not found');
    if (chat.runner.kind !== 'external') {
      // D14 the other way round: a MangoStudio chat's transcript must not gain a
      // turn a vendor produced. The repository forbids switching kinds once a
      // chat has messages; this forbids running the wrong one on it at all.
      throw new ExternalTurnRunnerMismatchError(input.chatId, 'its runner is MangoStudio');
    }
    if (!chat.workdir) throw new ExternalTurnWorkspaceMissingError(input.chatId);
    // Checked before the session is opened, so a rejected second send never
    // reaches the vendor at all.
    if (findActiveTurnByChat(input.chatId)) throw new ExternalTurnConflictError(input.chatId);

    const targetId = chat.runner.targetId;
    const handle = await sessions.ensureSession({
      userId: input.userId,
      chatId: input.chatId,
      environmentId: chat.environmentId,
      targetId,
      canonicalWorkspacePath: input.canonicalWorkspacePath,
      vendorAccountFingerprint: input.vendorAccountFingerprint ?? null,
      configuration: input.configuration,
    });
    input.observer?.onSession?.({
      sessionId: handle.sessionId,
      targetId,
      resumed: handle.resumed,
      ...(handle.fallbackReason ? { fallbackReason: handle.fallbackReason } : {}),
    });

    // The single-flight above can hand the same session to two sends that both
    // passed the check before either registered. Re-checking after the await is
    // what makes "never a second vendor session" true rather than likely.
    if (findActiveTurnByChat(input.chatId)) throw new ExternalTurnConflictError(input.chatId);

    return runTurn({ input, db, chat, targetId, handle });
  }

  async function runTurn(context: {
    readonly input: StartExternalTurnInput;
    readonly db: Kysely<Database>;
    readonly chat: { readonly environmentId: string };
    readonly targetId: ExternalAgentTargetId;
    readonly handle: ExternalSessionHandle;
  }): Promise<ExternalTurnResult> {
    const { input, db, handle, targetId } = context;
    const startedAt = now();
    const userMessageId = newId();
    const assistantMessageId = newId();
    const transcript = new ExternalTurnTranscript({
      targetId,
      sessionId: handle.sessionId,
      startedAt,
    });
    const writer = new ExternalTranscriptWriter(db, assistantMessageId, transcript, now);
    liveTurns.set(input.chatId, { transcript, writer });

    const settled = Promise.withResolvers<ExternalTurnTerminalReason>();
    let terminalReason: ExternalTurnTerminalReason | undefined;
    const external: ActiveExternalTurn = {
      sessionId: handle.sessionId,
      targetId,
      environmentId: context.chat.environmentId,
    };

    /** The first terminal writer wins; every later one is a no-op. */
    function terminate(reason: ExternalTurnTerminalReason): void {
      if (terminalReason) return;
      terminalReason = reason;
      transcript.finalize(reason, now());
      settled.resolve(reason);
    }

    /**
     * Terminal states the hub declared while the vendor was still talking.
     *
     * Every other terminal reason either came from the vendor saying it was done
     * or arrived with the session already closed. These two are the hub's own
     * verdict on a turn nobody told the vendor to stop, so without this the
     * vendor keeps acting after the transcript says it ended, and the runtime
     * refuses the next send because the session still has an active turn.
     */
    function cancelVendorAfter(reason: ExternalTurnTerminalReason): void {
      if (reason !== 'limit-exceeded' && reason !== 'sequence-gap') return;
      void handle.cancel(external.nativeTurnId).catch((error: unknown) => {
        logger.warn('cancel_failed', { sessionId: handle.sessionId, error: String(error) });
      });
    }

    /**
     * Approvals the vendor asked for before its own turn id reached the hub.
     *
     * The runtime publishes events as the adapter produces them, and the reply
     * to `external-agent.turn` is an ordinary response on the same socket, so an
     * eager vendor can ask a question before the hub knows what to address the
     * answer to. Holding those until the id arrives is what keeps such a turn
     * from blocking on a card nobody is allowed to answer.
     */
    const deferredApprovals: ExternalApprovalRequest[] = [];

    function bindApproval(request: ExternalApprovalRequest): void {
      const nativeTurnId = external.nativeTurnId;
      if (!nativeTurnId) {
        deferredApprovals.push(request);
        return;
      }
      approvals.register({
        binding: {
          userId: input.userId,
          chatId: input.chatId,
          sessionId: handle.sessionId,
          nativeTurnId,
          requestId: request.requestId,
        },
        request,
        forward: (optionId) =>
          handle.respond({ nativeTurnId, requestId: request.requestId, optionId }),
      });
    }

    const unsubscribe = handle.subscribe({
      onEnvelope(envelope, verdict) {
        if (terminalReason) return;
        switch (verdict.kind) {
          case 'duplicate':
            // A redelivery is a no-op, not an error.
            return;
          case 'gap':
            logger.warn('sequence_gap', {
              sessionId: handle.sessionId,
              expected: verdict.expected,
              received: verdict.received,
            });
            terminate('sequence-gap');
            cancelVendorAfter('sequence-gap');
            return;
          case 'after-terminal':
            logger.warn('event_after_terminal', {
              sessionId: handle.sessionId,
              nativeTurnId: verdict.nativeTurnId,
            });
            return;
          case 'foreign-turn':
            logger.warn('event_for_foreign_turn', {
              sessionId: handle.sessionId,
              nativeTurnId: verdict.nativeTurnId ?? null,
            });
            return;
          case 'apply':
            break;
        }

        const application = transcript.apply(envelope.event, {
          sequence: envelope.sequence,
          at: now(),
        });
        // `session_started` carries the vendor's own resumable session handle,
        // which is server-owned for the same reason the transcript omits it: a
        // client rendering the turn must see the hub-minted id `onSession`
        // reports and nothing that could address the vendor directly.
        if (envelope.event.type !== 'session_started') input.observer?.onEvent?.(envelope.event);

        if (application.approvalRequested) bindApproval(application.approvalRequested);

        void writer.write({ force: application.durable });
        if (application.terminal) {
          terminate(application.terminal);
          cancelVendorAfter(application.terminal);
        }
      },

      onTeardown(reason) {
        terminate(reason);
      },
    });

    registerActiveTurn(assistantMessageId, {
      userId: input.userId,
      chatId: input.chatId,
      external,
      abort: (reasonCode) => {
        const reason = terminalReasonForAbort(reasonCode);
        // The turn ends now even if the vendor is slow to acknowledge: the user
        // pressed stop, and a cancel the vendor never answers must not leave the
        // transcript running.
        terminate(reason);
        void handle.cancel(external.nativeTurnId).catch((error: unknown) => {
          logger.warn('cancel_failed', {
            sessionId: handle.sessionId,
            error: String(error),
          });
        });
      },
    });

    try {
      await persistTextTurnStart(
        {
          userId: input.userId,
          userMessageId,
          assistantMessageId,
          chatId: input.chatId,
          displayPrompt: input.prompt,
          ...(input.attachmentIds ? { attachmentIds: [...input.attachmentIds] } : {}),
          timestamp: startedAt,
          interactionMode: EXTERNAL_INTERACTION_MODE,
          // The vendor's model when it named one, otherwise the vendor itself.
          // There is no MangoStudio model behind an external turn to report.
          modelName: input.configuration.model ?? targetId,
          assistantParts: transcript.parts,
        },
        db
      );

      try {
        const nativeTurnId = await handle.startTurn({
          clientMessageId: userMessageId,
          input: input.prompt,
          configuration: input.configuration,
        });
        external.nativeTurnId = nativeTurnId;
        transcript.bindNativeTurn(nativeTurnId);
        handle.beginTurn(nativeTurnId);
        for (const request of deferredApprovals.splice(0)) bindApproval(request);
      } catch (error) {
        transcript.recordError(vendorErrorFrom(error, 'turn-start'));
        const reason = terminalReasonForCallFailure(error);
        terminate(reason);
        // The runtime no longer has this session, but the manager still caches
        // its handle and its continuation row. Left there, every later send is
        // handed the same dead session instead of opening a usable one. The
        // reap is not awaited — it drops the record synchronously, and only the
        // vendor's close call is slow.
        if (reason === 'session-lost') {
          void sessions.reapChat(input.chatId, reason).catch((reapError: unknown) => {
            logger.warn('reap_failed', {
              sessionId: handle.sessionId,
              error: String(reapError),
            });
          });
        }
      }

      const reason = await settled.promise;
      return await finish({
        input,
        db,
        handle,
        transcript,
        writer,
        userMessageId,
        assistantMessageId,
        reason,
        nativeTurnId: external.nativeTurnId,
        startedAt,
      });
    } finally {
      unsubscribe();
      unregisterActiveTurn(assistantMessageId);
      if (liveTurns.get(input.chatId)?.transcript === transcript) liveTurns.delete(input.chatId);
    }
  }

  async function finish(context: {
    readonly input: StartExternalTurnInput;
    readonly db: Kysely<Database>;
    readonly handle: ExternalSessionHandle;
    readonly transcript: ExternalTurnTranscript;
    readonly writer: ExternalTranscriptWriter;
    readonly userMessageId: string;
    readonly assistantMessageId: string;
    readonly reason: ExternalTurnTerminalReason;
    readonly nativeTurnId: string | undefined;
    readonly startedAt: number;
  }): Promise<ExternalTurnResult> {
    const { db, handle, transcript, input, reason, nativeTurnId } = context;
    const at = now();

    const abandonedSource = reason === 'cancelled-by-user' ? 'cancelled' : 'expired';
    if (nativeTurnId) {
      handle.endTurn(nativeTurnId);
      approvals.resolvePending(input.chatId, nativeTurnId, abandonedSource, at);
    }
    // An approval outstanding when the turn ends is dead. Recording it on the
    // transcript is what makes the reloaded card inert instead of a control that
    // will never resolve — and it is driven from the transcript rather than the
    // registry, so a request that never reached the registry is sealed too.
    for (const requestId of transcript.pendingApprovalIds()) {
      transcript.resolveApproval(requestId, { source: abandonedSource, at });
    }

    await context.writer.flush();
    const finalized = await finalizeCheckpointedAiResponse(
      {
        id: context.assistantMessageId,
        userId: input.userId,
        chatId: input.chatId,
        text: transcript.text,
        parts: transcript.parts,
        generationTime: `${((at - context.startedAt) / 1000).toFixed(1)}s`,
        // Mirrors the placeholder: a chat listing must not show a MangoStudio
        // model for a turn MangoStudio did not run.
        modelName: input.configuration.model ?? handle.targetId,
      },
      db
    );
    if (!finalized) {
      logger.warn('already_finalized', { messageId: context.assistantMessageId });
    }
    // Only the timestamp: an external turn has no MangoStudio agent profile, so
    // nothing that derives one from a completed turn applies to it.
    await updateChatAfterTurn(input.chatId, at, db);

    input.observer?.onTerminal?.(reason, transcript.turnPart.error);

    return {
      userMessageId: context.userMessageId,
      assistantMessageId: context.assistantMessageId,
      sessionId: handle.sessionId,
      ...(nativeTurnId ? { nativeTurnId } : {}),
      reason,
      ...(transcript.usage ? { usage: transcript.usage } : {}),
      ...(transcript.turnPart.error ? { error: transcript.turnPart.error } : {}),
    };
  }

  return {
    start,
    async answerApproval(input) {
      const result = await approvals.answer(input);
      if (result.status !== 'accepted') return result;
      // The vendor's `approval_resolved` echo is optional, and a turn that ends
      // without one would leave the card pending for `finish` to seal as
      // expired — a durable record contradicting the authorization that was
      // actually sent. Applying it here is idempotent: a later echo for the
      // same request finds the decision already recorded and changes nothing.
      const live = liveTurns.get(input.chatId);
      if (!live) return result;
      live.transcript.resolveApproval(input.requestId, {
        optionId: result.optionId,
        source: 'user',
        at: now(),
      });
      void live.writer.write({ force: true });
      return result;
    },
  };
}
