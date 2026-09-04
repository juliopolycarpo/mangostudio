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
import {
  type ExternalAgentAttachment,
  type ExternalAgentConfiguration,
  type ExternalAgentError,
  type ExternalAgentEvent,
  ExternalAgentEventSchema,
  type ExternalAgentSteerResult,
  type ExternalAgentTargetId,
  type ExternalApprovalRequest,
  type ExternalReviewTarget,
  type ExternalSteerRejectionReason,
  type ExternalTurnTerminalReason,
  type ExternalUsage,
} from '@mangostudio/shared/external-agents';
import type { TurnInterruptionReasonCode } from '@mangostudio/shared/turn-recovery';
import type { Kysely } from 'kysely';
import Value from 'typebox/value';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { publishActivityInvalidation } from '../../../services/realtime/activity-invalidation';
import { generateId } from '../../../utils/id';
import { recordTurnCompletedActivity } from '../../chats/application/record-turn-activity';
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
import { cacheExternalAccountLimitsBestEffort } from './external-account-limits';
import {
  type AnswerExternalApprovalResult,
  type ExternalApprovalRegistry,
  externalApprovalRegistry,
} from './external-approval-registry';
import {
  type ExternalCommandCatalogCache,
  externalCommandCatalogCache,
} from './external-command-catalog-cache';
import {
  type ExternalSessionHandle,
  type ExternalSessionManager,
  externalSessionManager,
} from './external-session-manager';

const logger = createDiagnosticLogger('external-turn-controller');

/** External turns are agent-shaped in every place that already branches on mode. */
const EXTERNAL_INTERACTION_MODE: Exclude<InteractionMode, 'image'> = 'agent';

/**
 * How long a turn's terminal path waits on a steer's runtime acknowledgement
 * before sealing the transcript without it.
 *
 * Far below the runtime's own steer timeout: that call is not aborted when the
 * turn ends, so waiting for it in full would leave Stop, or the vendor's own
 * completion, feeling hung for as long as that request does. Short enough that
 * the ordinary case — the vendor answers in well under a second — is never cut
 * short, long enough that a hung acknowledgement cannot make every send feel
 * broken.
 */
const STEER_TERMINATION_GRACE_MS = 3_000;

function delay(ms: number): { readonly promise: Promise<void>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

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

/** The session's adapter does not offer a vendor-native review of the working tree. */
export class ExternalTurnReviewUnsupportedError extends Error {
  constructor(chatId: string) {
    super(`The agent running chat "${chatId}" cannot review the working tree.`);
    this.name = 'ExternalTurnReviewUnsupportedError';
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
  /**
   * Both message rows exist and are readable. Reported after the write rather
   * than when the ids are minted: a client told about a message the insert then
   * failed to create would render, and then reconcile against, a row that is not
   * there.
   */
  onTurnPrepared?(ids: {
    readonly userMessageId: string;
    readonly assistantMessageId: string;
  }): void;
  onEvent?(event: ExternalAgentEvent): void;
  /**
   * Reported once per steer, with the resolved outcome only — never the
   * optimistic intermediate state the durable record briefly holds while the
   * vendor call is in flight, because nothing live could have acted on it
   * anyway.
   */
  onSteer?(steer: {
    readonly clientMessageId: string;
    readonly text: string;
    readonly status: 'accepted' | 'rejected';
    readonly reasonCode?: ExternalSteerRejectionReason;
  }): void;
  onTerminal?(reason: ExternalTurnTerminalReason, error?: ExternalAgentError): void;
}

interface StartExternalTurnInput {
  readonly userId: string;
  readonly chatId: string;
  readonly prompt: string;
  readonly attachmentIds?: readonly string[];
  /**
   * The same attachments, with their bytes, for the vendor.
   *
   * Resolved by the preflight rather than here: a file that cannot be read has
   * to fail before the 200 is committed, or the user watches a stream open and
   * then die. `attachmentIds` beside it is what the *message row* records, and
   * the two are separate because one is a durable reference and the other is a
   * payload that never touches the database.
   */
  readonly attachments?: readonly ExternalAgentAttachment[];
  readonly configuration: ExternalAgentConfiguration;
  /**
   * The workspace as the runtime canonicalized it. Server-resolved: a
   * client-supplied path would be the vendor's working directory.
   */
  readonly canonicalWorkspacePath: string;
  /** From discovery; absent when the adapter reported no account identity. */
  readonly vendorAccountFingerprint?: string | null;
  /**
   * The environment's attested credential home.
   *
   * Required, not optional. A turn that reached here without one is a turn the
   * isolation gate should have refused, and making the field optional would let
   * a future call site omit it and silently opt out of the check.
   */
  readonly credentialHomeFingerprint: string;
  /**
   * Runs this turn as a vendor-native review instead of relaying `prompt`.
   *
   * The prompt is still persisted — it is what the transcript shows the user
   * asked for — but nothing composes it into vendor input: `review/start` takes
   * a target, not a message. Everything else about the turn is unchanged, which
   * is the point: ordering, persistence, approvals, cancellation and recovery
   * are the same code as for any other turn.
   */
  readonly review?: { readonly target: ExternalReviewTarget };
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
  readonly commandCatalog?: ExternalCommandCatalogCache;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Overrides {@link STEER_TERMINATION_GRACE_MS}; a test's only hook for it. */
  readonly steerTerminationGraceMs?: number;
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
 * Best-effort discriminant read for logging an event this hub does not
 * recognize.
 *
 * Bounded, because this reads the one payload on the path that nothing has
 * validated — that is the entire reason the caller is in this branch — so the
 * string is whatever the runtime put there, at whatever length.
 */
function readEventType(event: unknown): string | undefined {
  const type = (event as { readonly type?: unknown } | null)?.type;
  return typeof type === 'string' ? type.slice(0, 128) : undefined;
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

  /**
   * A steering attempt cannot reach the vendor unless its durable record did.
   * Unlike ordinary checkpoints, its failure must be observable by the caller.
   */
  writeRequired(): Promise<void> {
    const text = this.transcript.text;
    const parts = JSON.stringify(this.transcript.parts);
    const required = this.#pending
      .then(() =>
        this.db
          .updateTable('messages')
          .set({ text, parts })
          .where('id', '=', this.messageId)
          .where('isGenerating', '=', 1)
          .execute()
      )
      .then(() => undefined);
    // Keep subsequent best-effort checkpoints usable if this required write
    // failed; the steering caller still receives the original rejection.
    this.#pending = required.then(
      () => undefined,
      (error: unknown) => {
        logger.warn('required_checkpoint_write_failed', {
          messageId: this.messageId,
          error: String(error),
        });
      }
    );
    return required;
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
  /**
   * Sends more input into the chat's currently running turn.
   *
   * `turn-already-completed` covers three histories the caller cannot tell
   * apart: no turn is running, one was but it ended, and `userId` does not
   * own the turn that is. The last one is deliberate — distinguishing it from
   * the other two would confirm that another user's turn is live on this
   * chat, the same reason a rejected approval answer never says "not yours."
   * `clientMessageId` is the idempotency key: a repeat with the same `text`
   * returns the outcome already recorded for it, without a second vendor
   * call. A repeat with different text under the same id is `id-reused`
   * rather than an answer to either attempt — it is a composer edit, not the
   * retry the id exists to make safe.
   */
  steer(input: {
    readonly userId: string;
    readonly chatId: string;
    readonly clientMessageId: string;
    readonly text: string;
  }): Promise<ExternalAgentSteerResult>;
}

/**
 * The transcript of one chat's live turn, so an answered approval or a steer
 * reaches the durable record without waiting for the vendor to echo it back.
 */
interface LiveExternalTurn {
  readonly transcript: ExternalTurnTranscript;
  readonly writer: ExternalTranscriptWriter;
  readonly sessionId: string;
  /** Mutable: the vendor's turn id arrives after the send is registered. */
  readonly external: ActiveExternalTurn;
  readonly handle: ExternalSessionHandle;
  readonly observer: ExternalTurnObserver | undefined;
  /** Who started this turn — `steer` refuses a caller this does not match. */
  readonly userId: string;
  /**
   * A vendor-native review. Refuses steering: a review has no conversation to
   * redirect, and the vendor refuses it too — this answers without the round
   * trip and without depending on the vendor to keep doing so.
   */
  readonly review: boolean;
  /**
   * Every steer this turn has attempted, keyed by `clientMessageId` and never
   * evicted for the life of the turn.
   *
   * The text travels with the promise so a repeat under the same id is only
   * ever answered from cache when it repeats the same text too — the
   * idempotent retry a lost acknowledgement legitimately causes. A promise
   * that rejected stays cached exactly the same way: the caller already
   * recorded the attempt and may have already called the vendor, so a naive
   * retry must reuse that failure rather than recording and dispatching a
   * second one for an outcome the server never learned.
   */
  readonly steerAttempts: Map<
    string,
    { readonly text: string; readonly promise: Promise<ExternalAgentSteerResult> }
  >;
  /**
   * `clientMessageId`s whose durable write has happened but whose outcome has
   * not been reported to `observer.onSteer` yet.
   *
   * While this is non-empty, `onEvent` notifications for vendor events that
   * arrive durably *after* one of these steers are held in
   * {@link LiveExternalTurn.deferredEvents} instead of sent immediately — the
   * durable transcript already put the steer first, and a live listener that
   * saw the vendor event first would render an order a reload disagrees with.
   */
  readonly pendingSteerIds: Set<string>;
  /** `onEvent` notifications held back by a non-empty {@link pendingSteerIds}, in arrival order. */
  readonly deferredEvents: Array<() => void>;
  /** Terminal delivery has begun; no new steering attempt may be recorded. */
  terminating: boolean;
  /**
   * Exposed so `steer` can seal the turn itself when a steer attempt pushes
   * the transcript past its byte or event budget — the same terminal path
   * `onEnvelope` drives for a vendor event that does the same thing.
   */
  readonly terminate: (reason: ExternalTurnTerminalReason) => void;
  readonly cancelVendorAfter: (reason: ExternalTurnTerminalReason) => void;
}

/**
 * Delivers every `onEvent` a pending steer was holding back, in the order
 * they arrived.
 *
 * Also the fallback for a steer that never got to report itself — the
 * terminal path's grace period lapsing, most likely — so a vendor event the
 * durable transcript already holds is never silently missing from what a
 * live listener sees.
 */
function flushDeferredEvents(live: LiveExternalTurn | undefined): void {
  if (!live || live.deferredEvents.length === 0) return;
  for (const emit of live.deferredEvents.splice(0)) emit();
}

export function createExternalTurnController(
  dependencies: ExternalTurnControllerDependencies = {}
): ExternalTurnController {
  const sessions = dependencies.sessions ?? externalSessionManager;
  const approvals = dependencies.approvals ?? externalApprovalRegistry;
  const commandCatalog = dependencies.commandCatalog ?? externalCommandCatalogCache;
  const now = dependencies.now ?? Date.now;
  const newId = dependencies.newId ?? generateId;
  const steerTerminationGraceMs =
    dependencies.steerTerminationGraceMs ?? STEER_TERMINATION_GRACE_MS;
  const liveTurns = new Map<string, LiveExternalTurn>();

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
      credentialHomeFingerprint: input.credentialHomeFingerprint,
      configuration: input.configuration,
    });
    // After the session is open, because only the adapter that answered `open`
    // can say what this machine's build supports — the descriptor the caller
    // preflighted against is cached, and this is not.
    if (input.review && !handle.capabilities.nativeReview) {
      throw new ExternalTurnReviewUnsupportedError(input.chatId);
    }
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

    const settled = Promise.withResolvers<ExternalTurnTerminalReason>();
    let terminalReason: ExternalTurnTerminalReason | undefined;
    const external: ActiveExternalTurn = {
      sessionId: handle.sessionId,
      targetId,
      environmentId: context.chat.environmentId,
    };
    liveTurns.set(input.chatId, {
      transcript,
      writer,
      sessionId: handle.sessionId,
      external,
      handle,
      observer: input.observer,
      userId: input.userId,
      review: input.review !== undefined,
      steerAttempts: new Map(),
      pendingSteerIds: new Set(),
      deferredEvents: [],
      terminating: false,
      terminate,
      cancelVendorAfter,
    });

    /** The first terminal writer wins; every later one is a no-op. */
    function terminate(reason: ExternalTurnTerminalReason): void {
      if (terminalReason) return;
      terminalReason = reason;
      const live = liveTurns.get(input.chatId);
      if (live?.transcript === transcript) live.terminating = true;
      // A steer is recorded before its runtime call. Give the in-flight call a
      // bounded chance to resolve and durably correct that record before
      // sealing the transcript, otherwise reload can disagree with the
      // returned outcome — but only a chance: that call is not aborted here,
      // so waiting for it in full would leave Stop, or the vendor's own
      // completion, blocked on however long a hung acknowledgement takes.
      const attempts = live
        ? [...live.steerAttempts.values()].map((attempt) => attempt.promise)
        : [];
      const grace = delay(steerTerminationGraceMs);
      void Promise.race([Promise.allSettled(attempts), grace.promise]).then(() => {
        grace.cancel();
        // Whatever the race waited for, no vendor event the durable transcript
        // already holds may stay unreported — including one a steer that
        // never got the chance to resolve was holding back.
        flushDeferredEvents(live);
        transcript.finalize(reason, now());
        settled.resolve(reason);
      });
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

        // The sequencer only ever checked addressing, so an envelope can reach
        // here with an `event` this hub's copy of `ExternalAgentEventSchema`
        // does not recognize — a runtime newer than the hub. `transcript.apply`
        // switches on `event.type` exhaustively and has no `default`: an
        // unrecognized member would fall off the end and hand the caller
        // `undefined` where an `ExternalTranscriptApplication` is expected.
        // Inertness is decided here, at the one call site that would otherwise
        // break, not by refusing the envelope earlier — its sequence is already
        // spent, and that is the fix.
        if (!Value.Check(ExternalAgentEventSchema, envelope.event)) {
          logger.warn('unrecognized_event_type', {
            sessionId: handle.sessionId,
            type: readEventType(envelope.event),
          });
          return;
        }

        const application = transcript.apply(envelope.event, {
          sequence: envelope.sequence,
          at: now(),
        });
        // `session_started` carries the vendor's own resumable session handle,
        // which is server-owned for the same reason the transcript omits it: a
        // client rendering the turn must see the hub-minted id `onSession`
        // reports and nothing that could address the vendor directly.
        if (envelope.event.type !== 'session_started') {
          const live = liveTurns.get(input.chatId);
          const emit = () => input.observer?.onEvent?.(envelope.event);
          // A pending steer's durable record already sits ahead of this event
          // in `transcript.parts`. Reporting the event now, before that steer
          // has been reported, would let a live listener see them in the
          // opposite order — held back until `steer` (or the terminal path's
          // grace fallback) flushes it, so live and reload always agree.
          if (live?.transcript === transcript && live.pendingSteerIds.size > 0) {
            live.deferredEvents.push(emit);
          } else {
            emit();
          }
        }

        if (envelope.event.type === 'account_limits') {
          // Discardable vendor state: a cache write must never disturb the turn.
          cacheExternalAccountLimitsBestEffort(
            {
              userId: input.userId,
              environmentId: context.chat.environmentId,
              targetId,
              vendorAccountFingerprint: input.vendorAccountFingerprint ?? null,
            },
            envelope.event.limits,
            { sessionId: handle.sessionId }
          );
        }

        if (envelope.event.type === 'commands_available') {
          // Last-known, not this chat's: a reload before this chat's own first
          // turn re-announces its catalog reads whatever a turn against this
          // (user, environment, target) wrote most recently, even one from a
          // different chat.
          commandCatalog.write(
            { userId: input.userId, environmentId: context.chat.environmentId, targetId },
            envelope.event.commands
          );
        }

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
      input.observer?.onTurnPrepared?.({ userMessageId, assistantMessageId });

      try {
        const nativeTurnId = input.review
          ? await startReviewTurn({
              handle,
              clientMessageId: userMessageId,
              target: input.review.target,
            })
          : await handle.startTurn({
              clientMessageId: userMessageId,
              input: input.prompt,
              configuration: input.configuration,
              ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            });
        external.nativeTurnId = nativeTurnId;
        transcript.bindNativeTurn(nativeTurnId);
        handle.beginTurn(nativeTurnId);
        for (const request of deferredApprovals.splice(0)) bindApproval(request);
      } catch (error) {
        transcript.recordError(
          vendorErrorFrom(error, input.review ? 'review-start' : 'turn-start')
        );
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
    // Every terminal reason reaches here; only the one that produced work is
    // worth a feed row. A cancelled or errored turn is already visible in the
    // chat it happened in, but its `updatedAt` still moved — so the sidebar
    // still needs the signal, just not a row to explain it.
    if (reason === 'completed') {
      void recordTurnCompletedActivity(input.userId, input.chatId, db);
    } else {
      publishActivityInvalidation(input.userId);
    }

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

  const instance: ExternalTurnController = {
    start,
    async answerApproval(input) {
      // The registry's five-way binding is only as strong as the values the
      // caller passes, and a client cannot pass the two that matter: the session
      // id and the vendor's turn id are server-owned and deliberately never
      // cross the wire. Reading them off the chat's *live* turn is what supplies
      // them — so an answer can only ever reach the turn running right now, and
      // a card left over from an earlier turn cannot match a later one that
      // happened to reuse its request id.
      const live = liveTurns.get(input.chatId);
      const result = await approvals.answer({
        ...input,
        ...(live ? { sessionId: live.sessionId } : {}),
        ...(live?.external.nativeTurnId ? { nativeTurnId: live.external.nativeTurnId } : {}),
      });
      if (result.status !== 'accepted') return result;
      // The vendor's `approval_resolved` echo is optional, and a turn that ends
      // without one would leave the card pending for `finish` to seal as
      // expired — a durable record contradicting the authorization that was
      // actually sent. Applying it here is idempotent: a later echo for the
      // same request finds the decision already recorded and changes nothing.
      if (!live) return result;
      live.transcript.resolveApproval(input.requestId, {
        optionId: result.optionId,
        source: 'user',
        at: now(),
      });
      void live.writer.write({ force: true });
      return result;
    },
    async steer(input) {
      const live = liveTurns.get(input.chatId);
      if (!live || live.terminating || live.transcript.terminated || live.userId !== input.userId) {
        return { accepted: false, reasonCode: 'turn-already-completed' };
      }
      // Before any durable record: a steer that cannot be delivered must not
      // leave "you, mid-turn" in a transcript nobody steered.
      if (live.review) return { accepted: false, reasonCode: 'turn-not-steerable' };

      const existing = live.steerAttempts.get(input.clientMessageId);
      if (existing) {
        // Same id, different text: not the lost-acknowledgement retry this
        // cache exists for, but a composer edit reusing a stale id. Answering
        // from the earlier attempt's outcome would silently discard the edit.
        if (existing.text !== input.text) return { accepted: false, reasonCode: 'id-reused' };
        return await existing.promise;
      }

      const attempt = (async (): Promise<ExternalAgentSteerResult> => {
        // Marks every vendor event applied from here until this steer is
        // reported as durably-after it, so `onEnvelope` holds them back
        // instead of notifying a live listener out of the durable order.
        live.pendingSteerIds.add(input.clientMessageId);
        try {
          // Durable *and awaited* before any vendor call is attempted: a write
          // still queued when the process died would be exactly the acknowledgement
          // loss this exists to prevent. Every rejection below corrects this same
          // record in place rather than leaving it silently absent.
          const recorded = live.transcript.recordSteerAttempt(
            { clientMessageId: input.clientMessageId, text: input.text },
            now()
          );
          await live.writer.writeRequired();
          if (recorded.terminal) {
            // This steer is what pushed the transcript past its byte or event
            // budget. It is already durably kept, matching how `apply` treats
            // the vendor event that does the same — but no vendor call follows
            // it: the turn is over, the same as any other budget breach.
            live.terminate(recorded.terminal);
            live.cancelVendorAfter(recorded.terminal);
            return { accepted: false, reasonCode: 'turn-already-completed' };
          }

          const outcome = await resolveSteerOutcome(live, input);
          if (!outcome.accepted) {
            live.transcript.resolveSteerRejected(input.clientMessageId, outcome.reasonCode);
            await live.writer.writeRequired();
          }
          live.observer?.onSteer?.({
            clientMessageId: input.clientMessageId,
            text: input.text,
            status: outcome.accepted ? 'accepted' : 'rejected',
            ...(outcome.accepted ? {} : { reasonCode: outcome.reasonCode }),
          });
          return outcome;
        } finally {
          live.pendingSteerIds.delete(input.clientMessageId);
          if (live.pendingSteerIds.size === 0) flushDeferredEvents(live);
        }
      })();
      // Cached before it settles, and never deleted: a concurrent repeat
      // shares this promise, and one that later throws stays cached too, so a
      // retry reuses this same attempt instead of recording and dispatching a
      // second one.
      live.steerAttempts.set(input.clientMessageId, { text: input.text, promise: attempt });
      return await attempt;
    },
  };
  return instance;
}

/**
 * Starts the review and checks that it landed where the hub is listening.
 *
 * Only inline delivery is requested, and inline means the review runs on this
 * session's own thread — so a `reviewThreadId` naming another one is a vendor
 * that changed its behaviour, not a case to accommodate. Refusing here rather
 * than proceeding is what keeps "the review ran" from meaning "its events went
 * somewhere nobody is reading": the failure surfaces on the turn, where the user
 * can see it.
 */
async function startReviewTurn(context: {
  readonly handle: ExternalSessionHandle;
  readonly clientMessageId: string;
  readonly target: ExternalReviewTarget;
}): Promise<string> {
  const started = await context.handle.startReview({
    clientMessageId: context.clientMessageId,
    target: context.target,
  });
  if (started.reviewThreadId !== context.handle.nativeSessionId) {
    // The turn is refused but it is already accepted over there. Nothing else
    // will stop it: the hub never learns its id — `finish` cancels only a turn
    // it recorded — so a vendor that ran it detached would keep the session
    // busy and the next send would be refused for a turn nobody can see.
    await context.handle.cancel(started.nativeTurnId).catch(() => undefined);
    throw new Error(
      `The review was started on session "${started.reviewThreadId}" instead of this chat's own.`
    );
  }
  return started.nativeTurnId;
}

/**
 * The two reasons only the vendor call can decide, plus the two the hub
 * already knows the answer to without making one.
 *
 * `not-supported` and a missing native turn id are checked first because
 * neither needs the runtime asked: a session whose capabilities never claimed
 * steering, or a turn the vendor has not named yet, cannot be steered no
 * matter what the call would say.
 */
async function resolveSteerOutcome(
  live: { readonly handle: ExternalSessionHandle; readonly external: ActiveExternalTurn },
  input: { readonly clientMessageId: string; readonly text: string }
): Promise<ExternalAgentSteerResult> {
  if (!live.handle.capabilities.steering) return { accepted: false, reasonCode: 'not-supported' };
  const nativeTurnId = live.external.nativeTurnId;
  if (!nativeTurnId) return { accepted: false, reasonCode: 'turn-already-completed' };
  try {
    return await live.handle.steer({
      nativeTurnId,
      clientMessageId: input.clientMessageId,
      text: input.text,
    });
  } catch (error) {
    // Mirrors `terminalReasonForCallFailure`: an argument the runtime rejects
    // is the session it no longer has, because the session id is the only
    // argument the hub itself chose.
    if (error instanceof Error && error.name === 'ToolArgumentError') {
      return { accepted: false, reasonCode: 'session-lost' };
    }
    throw error;
  }
}

/**
 * The hub's controller. One per process, because the live-turn map and the
 * approval registry it delegates to are process state: an answer posted to the
 * respond route has to reach the same instance that is streaming the turn.
 */
export const externalTurnController = createExternalTurnController();
