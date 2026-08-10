/**
 * The Cursor adapter, over the Agent Client Protocol.
 *
 * `cursor-agent acp` starts an ACP server Cursor documents for exactly this
 * purpose. That single fact replaced the whole of this adapter's original
 * design, which parsed print-mode `stream-json` and declared Cursor permanently
 * incapable of interactive approvals — a limitation of print mode, not of
 * Cursor. Over ACP the vendor asks, blocks and takes an answer, which is the
 * same shape Codex has and the same shape the neutral contract was built for.
 *
 * Process policy is the adapter's, as with Codex: ACP is a persistent stateful
 * JSON-RPC service, so this keeps one process per session for the session's
 * life. Nothing in the supervisor, the protocol or the hub knows that.
 *
 * Three things Cursor does differently from Codex, each of which shows up below:
 *
 * 1. **Notifications are session-scoped.** `session/update` carries no turn id,
 *    so the adapter — not the reducer — is what knows which turn is live, and a
 *    notification arriving between turns is dropped rather than attributed.
 * 2. **The turn's ending is a response.** `session/prompt` resolves with a
 *    `stopReason`; there is no terminal notification to wait for.
 * 3. **Configuration is session state, applied by its own calls.**
 *    `session/new` ignores a `modeId`, so the mode and the model are set with
 *    `session/set_mode` and `session/set_model` — which also means a permission
 *    change between turns needs no restart.
 *
 * Deliberately **not** used: print mode. It is per-invocation rather than a
 * persistent session, it duplicates partial text across buffered and final
 * flushes, and it can exit nonzero with no result event. `docs/providers/cursor.md`
 * records those facts so a future minimum-version fallback does not have to
 * rediscover them.
 */

import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExternalAgentCapabilities,
  ExternalAgentConfiguration,
  ExternalAgentEvent,
  ExternalAgentModel,
  ExternalAgentRuntimeDescriptor,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapter,
  ExternalAgentAdapterContext,
  ExternalAgentApprovalResponseInput,
  ExternalAgentCancelInput,
  ExternalAgentCloseInput,
  ExternalAgentListSessionsInput,
  ExternalAgentNativeSessionPage,
  ExternalAgentOpenedSession,
  ExternalAgentOpenSessionInput,
  ExternalAgentStartTurnInput,
  ExternalAgentTurnStream,
} from '../adapter';
import { ExternalAgentAdapterError, toExternalAgentError } from '../errors';
import { hostLocalDigestKey } from '../isolation';
import {
  type JsonRpcHandlers,
  type JsonRpcServerRequestOutcome,
  StdioJsonRpcClient,
} from '../jsonrpc';
import type { ExternalAgentManagedProcess } from '../process';
import { TurnChannel } from '../turn-channel';
import {
  type CursorRequestApproval,
  cursorCancelledOutcome,
  planCursorServerRequest,
} from './approvals';
import {
  CursorDiscoveryCache,
  type CursorDiscoveryFacts,
  type CursorDiscoveryRecord,
} from './discovery-cache';
import {
  buildCursorSupportedConfigurations,
  CURSOR_UNSUPPORTED_REASON_KEYS,
  cursorModeFor,
  cursorUnsupportedConfigurations,
} from './permissions';
import {
  CURSOR_ACP_PROTOCOL_VERSION,
  CURSOR_DISCOVERY_ATTEMPTS,
  CURSOR_DISCOVERY_CACHE_TTL_MS,
  CURSOR_DISCOVERY_FAILURE_CACHE_TTL_MS,
  CURSOR_LOGIN_COMMAND,
  CURSOR_PEER_NAME,
  CURSOR_VENDOR_ENVIRONMENT_KEYS,
  MINIMUM_CURSOR_AGENT_VERSION,
} from './pinned';
import type {
  AcpInitializeResponse,
  AcpModelState,
  AcpPromptResponse,
  AcpSessionListResponse,
  AcpSessionNotification,
  AcpSessionState,
  AcpStopReason,
  CursorStatusResponse,
} from './protocol';
import { CursorTurnReducer } from './reducer';
import { isCursorVersionSupported, requireCursorVersion } from './version';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * The ceiling on `session/prompt`, which is the whole turn.
 *
 * Effectively "never" — a day — because this request *is* the turn, not a call
 * that starts one. Timing it out would only stop MangoStudio listening while
 * Cursor kept running commands and writing files with nothing rendering it and
 * nothing able to stop it. What actually bounds a turn is the supervisor's hard
 * timeout and its idle timeout, both of which cancel through `session/cancel` —
 * which is also what makes this call resolve.
 */
const TURN_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;

/** Parsed once: every gate compares structures rather than re-parsing a string. */
const MINIMUM_CURSOR_VERSION_PARSED = requireCursorVersion(MINIMUM_CURSOR_AGENT_VERSION);

/** Same ceiling the neutral catalog schema enforces, applied before it is reached. */
const MODEL_CATALOG_LIMIT = 256;

/**
 * What ACP genuinely supports on the pinned build, as opposed to what the
 * neutral contract has room for.
 *
 * Everything here is derived from the handshake at discovery rather than
 * declared — see `capabilitiesFrom`. This constant is the floor the derivation
 * starts from, and the four opportunistic capabilities stay false: a flag cannot
 * disagree with an implementation, because the registry's conformance check
 * derives the optional ones from whether the member exists.
 *
 * `usageReporting` is false because ACP has no usage channel and Cursor sends
 * none — a live turn produced text, reasoning and tool calls and no token
 * figures at all. `steering` is false because there is no same-turn equivalent
 * of Codex's interrupt-and-continue.
 */
const CURSOR_BASE_CAPABILITIES: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  reasoningStream: true,
  interactiveApprovals: true,
  cancellation: true,
};

interface PendingApproval {
  readonly approval: CursorRequestApproval;
  settle(outcome: JsonRpcServerRequestOutcome): void;
}

interface ActiveTurn {
  readonly handle: string;
  readonly channel: TurnChannel<ExternalAgentEvent>;
  readonly reducer: CursorTurnReducer;
  cancelled?: boolean;
}

interface CursorSession {
  readonly client: StdioJsonRpcClient;
  readonly process: ExternalAgentManagedProcess;
  nativeSessionId: string;
  /** The mode and model currently in force, so a turn only sets what changed. */
  appliedModeId?: string;
  appliedModelId?: string;
  readonly approvals: Map<string, PendingApproval>;
  activeTurn?: ActiveTurn;
}

/** A live ACP process with a completed, version-checked handshake. */
interface LaunchedAcpConnection {
  readonly client: StdioJsonRpcClient;
  readonly process: ExternalAgentManagedProcess;
  readonly initialize: AcpInitializeResponse;
}

/** One handshake plus everything discovery reads off it. */
interface CursorProbe {
  readonly initialize: AcpInitializeResponse;
  readonly session?: AcpSessionState;
}

export class CursorAcpAdapter implements ExternalAgentAdapter {
  readonly targetId: ExternalAgentTargetId = 'cursor';

  readonly vendorEnvironmentKeys = CURSOR_VENDOR_ENVIRONMENT_KEYS;

  readonly #sessions = new Map<string, CursorSession>();
  readonly #now: () => number;
  readonly #discoveryCache: CursorDiscoveryCache;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#discoveryCache = new CursorDiscoveryCache({
      successTtlMs: CURSOR_DISCOVERY_CACHE_TTL_MS,
      failureTtlMs: CURSOR_DISCOVERY_FAILURE_CACHE_TTL_MS,
      now: this.#now,
    });
  }

  async discover(context: ExternalAgentAdapterContext): Promise<ExternalAgentRuntimeDescriptor> {
    const executablePath = context.executablePath;
    const version = executablePath ? await this.#readVersion(context) : undefined;
    if (!executablePath || !version) {
      return {
        targetId: this.targetId,
        installed: false,
        authState: 'unknown',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: [],
        loginCommand: CURSOR_LOGIN_COMMAND,
      };
    }

    // The same gate `openSession` applies, applied where the choice is offered
    // rather than only where it is taken: without it a too-old binary produces a
    // selectable target whose failure surfaces after someone sends a message.
    if (!isCursorVersionSupported(version.parsed, MINIMUM_CURSOR_VERSION_PARSED)) {
      return {
        targetId: this.targetId,
        installed: true,
        version: version.raw,
        authState: 'unknown',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: cursorUnsupportedConfigurations(
          CURSOR_UNSUPPORTED_REASON_KEYS.versionTooOld
        ),
      };
    }

    // Auth is read before the cache is consulted, not after: the account is part
    // of the cache key, so serving a remembered catalog for an account that has
    // since changed is the one stale answer that would be actively wrong.
    const status = await this.#readStatus(context);
    const facts: CursorDiscoveryFacts = {
      executablePath,
      version: version.raw,
      ...(status.fingerprint === undefined
        ? { accountFingerprint: undefined }
        : { accountFingerprint: status.fingerprint }),
    };

    const cached = this.#discoveryCache.read(facts);
    if (cached) return withDiscoveryReport(cached);

    const probe = await this.#probeWithRetries(context);
    if (!probe.ok) {
      return withDiscoveryReport(
        this.#discoveryCache.write(facts, {
          attempts: probe.attempts,
          failureCode: probe.code,
          descriptor: {
            targetId: this.targetId,
            installed: true,
            version: version.raw,
            authState: status.authState,
            ...(status.authState === 'signed-in' ? {} : { loginCommand: CURSOR_LOGIN_COMMAND }),
            capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
            supportedConfigurations: cursorUnsupportedConfigurations(
              CURSOR_UNSUPPORTED_REASON_KEYS.handshakeFailed
            ),
            ...(status.account ? { account: status.account } : {}),
          },
        })
      );
    }

    const models = modelCatalogFrom(probe.value.session?.models);
    return withDiscoveryReport(
      this.#discoveryCache.write(facts, {
        attempts: probe.attempts,
        descriptor: {
          targetId: this.targetId,
          installed: true,
          version: version.raw,
          authState: status.authState,
          ...(status.authState === 'signed-in' ? {} : { loginCommand: CURSOR_LOGIN_COMMAND }),
          capabilities: capabilitiesFrom(probe.value),
          supportedConfigurations: buildCursorSupportedConfigurations(probe.value.session?.modes),
          ...(models.length > 0 ? { models } : {}),
          ...(status.account ? { account: status.account } : {}),
        },
      })
    );
  }

  async openSession(input: ExternalAgentOpenSessionInput): Promise<ExternalAgentOpenedSession> {
    const { params, context } = input;
    await this.#assertSupportedVersion(context);

    const sessionId = params.sessionId;
    const launched = await this.#launch(context, {
      onNotification: (method, notificationParams) =>
        this.#onNotification(sessionId, method, notificationParams),
      onServerRequest: (method, requestParams, requestId) =>
        this.#onServerRequest(sessionId, method, requestParams, requestId),
    });

    const session: CursorSession = {
      client: launched.client,
      process: launched.process,
      nativeSessionId: '',
      approvals: new Map(),
    };
    // Registered before `session/new` so a permission request arriving during
    // the handshake finds a session to answer against rather than a missing one.
    this.#sessions.set(sessionId, session);

    try {
      const started = await this.#startOrLoadSession(
        launched.client,
        launched.initialize,
        params,
        context
      );
      session.nativeSessionId = started.nativeSessionId;
      // Applied after the session exists, because `session/new` ignores a
      // `modeId` — verified on the live build, which answered `currentModeId:
      // "agent"` for a request that asked for `plan`. The echo below is what the
      // UI shows, so it reports what these calls actually put in force.
      const applied = await this.#applyConfiguration(
        session,
        params.configuration,
        started.state,
        context
      );
      return {
        nativeSessionId: started.nativeSessionId,
        resumed: started.resumed,
        ...(started.fallbackReason ? { fallbackReason: started.fallbackReason } : {}),
        effectiveConfiguration: applied,
        capabilities: capabilitiesFrom({
          initialize: launched.initialize,
          ...(started.state ? { session: started.state } : {}),
        }),
      };
    } catch (error) {
      this.#sessions.delete(sessionId);
      // A session that could not be configured is not a session anyone asked
      // for, and the cached descriptor that said it would work is now suspect.
      this.#discoveryCache.invalidate();
      await launched.client.close().catch(() => undefined);
      await launched.process.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Starts a turn and returns its stream synchronously.
   *
   * The handle is the hub's own `clientMessageId`. Cursor never names a turn —
   * `session/prompt` is one request whose response *is* the ending — so unlike
   * Codex there is no vendor turn id to wait for and no pre-bind window to
   * buffer across.
   */
  startTurn(input: ExternalAgentStartTurnInput): ExternalAgentTurnStream {
    const session = this.#requireSession(input.params.sessionId);
    const handle = input.params.clientMessageId;
    const channel = new TurnChannel<ExternalAgentEvent>();
    const active: ActiveTurn = { handle, channel, reducer: new CursorTurnReducer(this.#now) };
    session.activeTurn = active;

    const run = async (): Promise<void> => {
      try {
        // Per-turn configuration, applied before the prompt so a permission or
        // model change between turns takes effect without a new session.
        await this.#applyConfiguration(session, input.params.configuration, undefined, undefined);
        const answered = await session.client.request<AcpPromptResponse>(
          'session/prompt',
          {
            sessionId: session.nativeSessionId,
            prompt: buildPromptBlocks(input),
          },
          // Deliberately no timeout that could outlive the turn and no abort
          // signal: `session/prompt` is the turn, so a client that stopped
          // listening would leave Cursor running commands nobody can see. The
          // supervisor's hard timeout and `cancel` are what bound it, and
          // `session/cancel` makes the vendor resolve this very call.
          TURN_REQUEST_TIMEOUT_MS,
          undefined
        );
        this.#finishTurn(session, active, answered.stopReason);
      } catch (error) {
        if (active.cancelled) return;
        // A turn that failed cannot answer an approval, and an unanswered one
        // blocks the whole connection rather than just this turn.
        this.#releaseApprovals(session);
        // Close the pills before the error, so a failed turn does not leave a
        // tool call rendering as still running.
        for (const event of active.reducer.finish('error')) {
          if (event.type === 'activity_completed') active.channel.push(event);
        }
        active.channel.push({
          type: 'error',
          error: toExternalAgentError(error, 'cursor-turn-failed'),
        });
        active.channel.finish();
        if (session.activeTurn === active) session.activeTurn = undefined;
      }
    };
    void run();

    return {
      nativeTurnId: handle,
      [Symbol.asyncIterator]: () => channel.drain(),
    };
  }

  /**
   * Answering is synchronous — it resolves the promise the server request is
   * parked on — but every failure still has to arrive as a **rejection**, since
   * a caller that attaches `.catch` without awaiting would miss a throw.
   */
  respond(input: ExternalAgentApprovalResponseInput): Promise<void> {
    try {
      this.#respond(input);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async cancel(input: ExternalAgentCancelInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return;
    this.#releaseApprovals(session);

    const active = session.activeTurn;
    if (active) active.cancelled = true;
    if (session.nativeSessionId) {
      // A notification, not a request: ACP defines `session/cancel` as one, and
      // the acknowledgement is `session/prompt` resolving with `cancelled`.
      await session.client
        .notify('session/cancel', { sessionId: session.nativeSessionId })
        .catch(() => undefined);
    }
    if (active) {
      for (const event of active.reducer.finish('cancelled')) active.channel.push(event);
      active.channel.finish();
      session.activeTurn = undefined;
    }
  }

  async close(input: ExternalAgentCloseInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return;
    this.#sessions.delete(input.sessionId);
    this.#releaseApprovals(session);
    session.activeTurn?.channel.finish();
    session.activeTurn = undefined;
    await session.client.close().catch(() => undefined);
    await session.process.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
  }

  /**
   * `session/list`, on a connection that is already open.
   *
   * One caveat is encoded by *not* being encoded: list membership is eventually
   * consistent. A session created earlier in the same cwd that never received a
   * prompt did not appear in a later listing, while one created in the listing
   * run did. So nothing here assumes a just-created session is listable, and
   * plan 013 re-reads a session's metadata when it adopts one rather than
   * trusting this page.
   *
   * *Which* connection answers is the caller's to say. This adapter runs one
   * `cursor-agent` per session, each with its own cwd and environment, so
   * asking whichever opened first would answer a question about one workspace
   * with another workspace's sessions. With no id given there is either a single
   * session or an ambiguity worth failing on.
   */
  async listSessions(
    input: ExternalAgentListSessionsInput
  ): Promise<ExternalAgentNativeSessionPage> {
    const session = this.#listingSession(input.sessionId);
    const listed = await session.client.request<AcpSessionListResponse>(
      'session/list',
      input.cursor === undefined ? {} : { cursor: input.cursor },
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    const sessionIds = (listed.sessions ?? [])
      .map((entry) => entry.sessionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return {
      sessionIds,
      ...(typeof listed.nextCursor === 'string' && listed.nextCursor.length > 0
        ? { nextCursor: listed.nextCursor }
        : {}),
    };
  }

  #listingSession(sessionId: string | undefined): CursorSession {
    if (sessionId !== undefined) return this.#requireSession(sessionId);
    const open = [...this.#sessions.values()];
    if (open.length === 1) return open[0] as CursorSession;
    throw new ExternalAgentAdapterError(
      'cursor-no-connection',
      open.length === 0
        ? 'Listing Cursor sessions needs an open ACP connection.'
        : 'Listing Cursor sessions needs the session to list them on; more than one is open.'
    );
  }

  #respond(input: ExternalAgentApprovalResponseInput): void {
    const session = this.#requireSession(input.sessionId);
    const pending = session.approvals.get(input.requestId);
    if (!pending) {
      throw new ExternalAgentAdapterError(
        'cursor-approval-unknown',
        `Cursor approval "${input.requestId}" is no longer awaiting an answer.`
      );
    }
    session.approvals.delete(input.requestId);

    // `expiresAtMs` is a promise made to the person looking at the card, and it
    // binds the answer as well as the wait. Refused rather than converted into a
    // rejection of the request: choosing an option on the user's behalf would be
    // MangoStudio answering a vendor question about their machine.
    if (this.#now() >= pending.approval.request.expiresAtMs) {
      pending.settle({ result: cursorCancelledOutcome() });
      session.activeTurn?.channel.push({
        type: 'approval_resolved',
        requestId: input.requestId,
        decision: { optionId: input.optionId, source: 'expired' },
      });
      throw new ExternalAgentAdapterError(
        'cursor-approval-expired',
        `Cursor approval "${input.requestId}" expired before this answer arrived.`
      );
    }

    let result: unknown;
    try {
      result = pending.approval.encode(input.optionId);
    } catch (error) {
      // The rejection is the vendor's option set talking, so it has to reach the
      // caller — but Cursor is still blocked, and leaving it that way would hang
      // the turn rather than fail the call.
      pending.settle({ result: cursorCancelledOutcome() });
      throw error;
    }
    pending.settle({ result });
    session.activeTurn?.channel.push({
      type: 'approval_resolved',
      requestId: input.requestId,
      decision: { optionId: input.optionId, source: 'user' },
    });
  }

  /** Answers every blocked permission request so no vendor call outlives its turn. */
  #releaseApprovals(session: CursorSession): void {
    for (const [requestId, pending] of [...session.approvals]) {
      session.approvals.delete(requestId);
      pending.settle({ result: cursorCancelledOutcome() });
    }
  }

  #requireSession(sessionId: string): CursorSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new ExternalAgentAdapterError(
        'cursor-session-missing',
        `Cursor session "${sessionId}" is not open.`
      );
    }
    return session;
  }

  /**
   * Ends a turn, and with it every question the turn was still asking.
   *
   * The same release `cancel` and `close` perform, for the ending they do not
   * cover. It is the error path that needs it: `session/prompt` rejecting on its
   * own timeout leaves a parked request unanswered, and because the pump answers
   * server requests one at a time, one unanswered request blocks every later
   * frame on that connection — the session never recovers, and a later `respond`
   * pushes `approval_resolved` into a channel this call already finished.
   *
   * Releasing on the success path costs nothing and is where the rule belongs.
   * Today it cannot fire — a serial pump cannot read the prompt's response while
   * an approval is parked — so it holds the invariant rather than the pump.
   */
  #finishTurn(
    session: CursorSession,
    active: ActiveTurn,
    stopReason: AcpStopReason | undefined
  ): void {
    this.#releaseApprovals(session);
    for (const event of active.reducer.finish(stopReason)) active.channel.push(event);
    active.channel.finish();
    if (session.activeTurn === active) session.activeTurn = undefined;
  }

  #onNotification(sessionId: string, method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const session = this.#sessions.get(sessionId);
    const active = session?.activeTurn;
    if (!session || !active) return;
    const notification = params as AcpSessionNotification;
    // Session-scoped, so this is the only correlation there is. A notification
    // for another ACP session on the same connection is not this turn's.
    if (notification.sessionId !== session.nativeSessionId) return;
    for (const event of active.reducer.reduce(notification.update).events) {
      active.channel.push(event);
    }
  }

  async #onServerRequest(
    sessionId: string,
    method: string,
    params: unknown,
    requestId: string
  ): Promise<JsonRpcServerRequestOutcome> {
    const plan = planCursorServerRequest(method, params, requestId, this.#now());
    if (plan.outcome === 'refuse') {
      return { error: { code: plan.code, message: plan.message } };
    }
    const session = this.#sessions.get(sessionId);
    const active = session?.activeTurn;
    if (!session || !active) {
      // ACP's own word for "the client is not answering". Not a decision: there
      // is nobody to ask, and an error frame would read to the vendor as a
      // protocol fault rather than as an unanswered prompt.
      return { result: cursorCancelledOutcome() };
    }

    // The vendor stays blocked here on purpose: this promise resolves when
    // `respond` arrives, when the turn is cancelled, or when the session closes.
    // `expiresAtMs` is what stops it being forever, and the supervisor suspends
    // its idle timeout for exactly that long.
    return await new Promise<JsonRpcServerRequestOutcome>((settle) => {
      session.approvals.set(requestId, { approval: plan, settle });
      active.channel.push({ type: 'approval_requested', request: plan.request });
    });
  }

  async #assertSupportedVersion(context: ExternalAgentAdapterContext): Promise<void> {
    const version = await this.#readVersion(context);
    if (isCursorVersionSupported(version?.parsed, MINIMUM_CURSOR_VERSION_PARSED)) return;
    throw new ExternalAgentAdapterError(
      'cursor-version-unsupported',
      version
        ? `cursor-agent ${version.raw} predates the ${MINIMUM_CURSOR_AGENT_VERSION} this runtime speaks. Upgrade the Cursor CLI.`
        : 'The Cursor CLI did not report a version this runtime could read.'
    );
  }

  /**
   * `cursor-agent --version` off the executable the runtime scanner resolved.
   *
   * Never the `cursor` editor binary: prior detection work on this repository
   * found `cursor-agent` probes reliably while the plain `cursor` version probe
   * timed out, and the scanner's `CURSOR_AGENT_CLI_DEFINITION` already names the
   * right one.
   */
  async #readVersion(
    context: ExternalAgentAdapterContext
  ): Promise<{ raw: string; parsed: ReturnType<typeof requireCursorVersion> | null } | undefined> {
    const executable = context.executablePath;
    if (!executable) return undefined;
    const managed = context.spawn({ argv: [executable, '--version'] });
    try {
      const read = await managed.stdout.next(HANDSHAKE_TIMEOUT_MS, context.signal);
      if (read.kind !== 'line') return undefined;
      const raw = read.line.trim();
      if (raw.length === 0) return undefined;
      let parsed: ReturnType<typeof requireCursorVersion> | null = null;
      try {
        parsed = requireCursorVersion(raw);
      } catch {
        // An unparseable version is "not established", never "new enough".
        parsed = null;
      }
      return { raw, parsed };
    } catch {
      return undefined;
    } finally {
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
  }

  /**
   * `cursor-agent status --format json` — sign-in state and nothing more.
   *
   * The response carries the signed-in address, a numeric user id and a name.
   * None of that leaves the runtime: what crosses is a label the owner can
   * recognize plus a keyed fingerprint whose only job is to notice that the
   * account behind a session changed.
   */
  async #readStatus(context: ExternalAgentAdapterContext): Promise<{
    authState: 'signed-in' | 'signed-out' | 'unknown';
    account?: { label: string; fingerprint?: string };
    fingerprint?: string;
  }> {
    const executable = context.executablePath;
    if (!executable) return { authState: 'unknown' };
    const managed = context.spawn({ argv: [executable, 'status', '--format', 'json'] });
    try {
      const body = await readJsonDocument(managed, context.signal);
      if (!body) return { authState: 'unknown' };
      const status = body as CursorStatusResponse;
      const signedIn = status.isAuthenticated === true || status.status === 'authenticated';
      if (!signedIn) return { authState: 'signed-out' };
      const fingerprint = status.userInfo?.email
        ? fingerprintAccount(status.userInfo.email)
        : undefined;
      return {
        authState: 'signed-in',
        account: { label: 'Cursor', ...(fingerprint ? { fingerprint } : {}) },
        ...(fingerprint ? { fingerprint } : {}),
      };
    } catch {
      return { authState: 'unknown' };
    } finally {
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
  }

  /**
   * The discovery probe, retried for the failures a retry can fix.
   *
   * A cold binary losing a race with its own startup and a machine too loaded to
   * make the handshake deadline both clear on a second attempt. A missing `acp`
   * subcommand, an unexpected protocol version and a signed-out account fail
   * identically however many times they are asked — and discovery is on the path
   * to rendering a selector — so the ceiling is low and the reason is recorded
   * either way.
   */
  async #probeWithRetries(
    context: ExternalAgentAdapterContext
  ): Promise<
    | { ok: true; value: CursorProbe; attempts: number }
    | { ok: false; code: string; attempts: number }
  > {
    let lastCode = 'cursor-handshake-failed';
    for (let attempt = 1; attempt <= CURSOR_DISCOVERY_ATTEMPTS; attempt += 1) {
      if (context.signal.aborted) {
        return { ok: false, code: 'cursor-discovery-aborted', attempts: attempt };
      }
      try {
        return { ok: true, value: await this.#probe(context), attempts: attempt };
      } catch (error) {
        lastCode =
          error instanceof ExternalAgentAdapterError ? error.code : 'cursor-handshake-failed';
        // A protocol version this client does not speak is not transient, and a
        // second handshake would negotiate the same number.
        if (lastCode === 'cursor-protocol-unsupported') {
          return { ok: false, code: lastCode, attempts: attempt };
        }
      }
    }
    return { ok: false, code: lastCode, attempts: CURSOR_DISCOVERY_ATTEMPTS };
  }

  /**
   * One handshake, plus the throwaway session the model catalog needs.
   *
   * Cursor has no account-level model list — `session/new` is the only place a
   * catalog appears — so discovery has to open one. Two properties make that
   * acceptable rather than a side effect nobody agreed to:
   *
   * - It is rooted in a **fresh empty temp directory**, never the user's
   *   workspace or the runtime's own cwd. Opening a session against a real
   *   workspace would load that workspace's Cursor rules, project configuration
   *   and MCP server definitions — a decision about executing third-party
   *   configuration, and not one that discovery gets to make on the user's
   *   behalf.
   * - The session is never prompted, and an unprompted session does not appear
   *   in `session/list` (verified against the live build), so it does not litter
   *   the user's own session history.
   *
   * A `session/new` that fails is not fatal: the handshake already established
   * whether the target works, and a descriptor with no catalog hides the model
   * selector rather than rendering an empty one.
   */
  async #probe(context: ExternalAgentAdapterContext): Promise<CursorProbe> {
    let launched: LaunchedAcpConnection | undefined;
    let scratch: string | undefined;
    try {
      launched = await this.#launch(context, {
        onNotification: () => undefined,
        // Discovery runs no turn, so there is nobody to ask. ACP's `cancelled`
        // outcome says exactly that; nothing here approves anything.
        onServerRequest: (method, params, requestId) => {
          const plan = planCursorServerRequest(method, params, requestId, this.#now());
          return plan.outcome === 'refuse'
            ? { error: { code: plan.code, message: plan.message } }
            : { result: cursorCancelledOutcome() };
        },
      });
      scratch = await mkdtemp(join(tmpdir(), 'mangostudio-cursor-probe-'));
      const session = await launched.client
        .request<AcpSessionState>(
          'session/new',
          { cwd: scratch, mcpServers: [] },
          DEFAULT_REQUEST_TIMEOUT_MS,
          context.signal
        )
        .catch(() => undefined);
      return {
        initialize: launched.initialize,
        ...(session ? { session } : {}),
      };
    } finally {
      await launched?.client.close().catch(() => undefined);
      await launched?.process.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #launch(
    context: ExternalAgentAdapterContext,
    handlers: JsonRpcHandlers
  ): Promise<LaunchedAcpConnection> {
    const executable = context.executablePath;
    if (!executable) {
      throw new ExternalAgentAdapterError('cursor-not-installed', 'The Cursor CLI was not found.');
    }
    const managed = context.spawn({ argv: [executable, 'acp'] });
    const client = new StdioJsonRpcClient(managed, handlers, CURSOR_PEER_NAME);
    try {
      const initialize = await client.request<AcpInitializeResponse>(
        'initialize',
        {
          protocolVersion: CURSOR_ACP_PROTOCOL_VERSION,
          // Every one of these is false, and each false is load-bearing.
          // `fs/*` and `terminal/*` are ACP asking the *client* to touch the
          // machine on the agent's behalf, which is MangoStudio's own tool
          // surface reached through a vendor's protocol. Declining them here is
          // what `approvals.ts` refusing them makes true.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        HANDSHAKE_TIMEOUT_MS,
        context.signal
      );
      // An unexpected protocol version makes the target unavailable with a typed
      // reason. It never silently downgrades to something else: the frames this
      // reducer knows are protocol 1's, and pretending otherwise would produce a
      // transcript that looks right until it does not.
      if (initialize.protocolVersion !== CURSOR_ACP_PROTOCOL_VERSION) {
        throw new ExternalAgentAdapterError(
          'cursor-protocol-unsupported',
          `Cursor negotiated ACP protocol ${String(initialize.protocolVersion)}; this runtime speaks ${CURSOR_ACP_PROTOCOL_VERSION}.`
        );
      }
      return { client, process: managed, initialize };
    } catch (error) {
      await client.close().catch(() => undefined);
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * `session/new` for a fresh conversation, `session/load` to resume one.
   *
   * `session/load` is only attempted when the handshake advertised
   * `loadSession`: a build that did not would answer "method not found", and a
   * `fallback` resume would then quietly start fresh for a reason that is not
   * about the session at all. It also returns no `sessionId` of its own — only
   * `modes` and `models` — so the id that comes back is the one that was asked
   * for.
   *
   * `resumeMode` is honored exactly as the Codex adapter honors it. `strict`
   * exists so a caller that asked for *this* session is never silently handed a
   * different one; plan 013 adopts a session the user picked by name, and
   * quietly starting another there is the bug the mode was added to prevent.
   */
  async #startOrLoadSession(
    client: StdioJsonRpcClient,
    initialize: AcpInitializeResponse,
    params: ExternalAgentOpenSessionInput['params'],
    context: ExternalAgentAdapterContext
  ): Promise<{
    nativeSessionId: string;
    state?: AcpSessionState;
    resumed: boolean;
    fallbackReason?: string;
  }> {
    const request = { cwd: params.workspacePath, mcpServers: [] };
    const startFresh = async () => {
      const state = await client.request<AcpSessionState>(
        'session/new',
        request,
        DEFAULT_REQUEST_TIMEOUT_MS,
        context.signal
      );
      const nativeSessionId = state.sessionId;
      if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
        throw new ExternalAgentAdapterError(
          'cursor-session-unnamed',
          'Cursor opened a session without naming it.'
        );
      }
      return { nativeSessionId, state, resumed: false as const };
    };

    if (!params.resumeRef) return startFresh();

    const canLoad = initialize.agentCapabilities?.loadSession === true;
    if (!canLoad) {
      if (params.resumeMode === 'strict') {
        throw new ExternalAgentAdapterError(
          'cursor-resume-unsupported',
          'This cursor-agent build does not advertise session loading.'
        );
      }
      return { ...(await startFresh()), fallbackReason: 'This Cursor build cannot load sessions.' };
    }

    try {
      const state = await client.request<AcpSessionState>(
        'session/load',
        { ...request, sessionId: params.resumeRef },
        DEFAULT_REQUEST_TIMEOUT_MS,
        context.signal
      );
      return { nativeSessionId: params.resumeRef, state, resumed: true };
    } catch (error) {
      if (params.resumeMode === 'strict') {
        throw new ExternalAgentAdapterError(
          'cursor-resume-failed',
          `Cursor could not load session "${params.resumeRef}": ${errorText(error)}`
        );
      }
      return { ...(await startFresh()), fallbackReason: errorText(error) };
    }
  }

  /**
   * Puts the requested mode and model in force, and reports what is actually
   * set.
   *
   * Both are session state applied by their own calls, and both are echoed
   * rather than assumed: a `session/set_mode` for a mode this account does not
   * offer fails loudly (`Invalid mode ID: …`), and reporting the requested value
   * as active would show a permission level the vendor is not running under.
   * A failure to apply the *level* is fatal — running `agent` when the user
   * asked for `plan` is a permission escalation — while a failure to apply the
   * model is not: the vendor's own default is a legitimate answer and is what
   * gets reported.
   */
  async #applyConfiguration(
    session: CursorSession,
    configuration: ExternalAgentConfiguration,
    state: AcpSessionState | undefined,
    context: ExternalAgentAdapterContext | undefined
  ): Promise<ExternalAgentConfiguration> {
    const signal = context?.signal;
    const modeId = cursorModeFor(configuration.level);
    if (!modeId) {
      throw new ExternalAgentAdapterError(
        'cursor-level-unsupported',
        `Cursor has no ACP session mode for the "${configuration.level}" permission level.`
      );
    }

    const currentMode = session.appliedModeId ?? state?.modes?.currentModeId;
    if (currentMode !== modeId) {
      await session.client.request(
        'session/set_mode',
        { sessionId: session.nativeSessionId, modeId },
        DEFAULT_REQUEST_TIMEOUT_MS,
        signal
      );
      session.appliedModeId = modeId;
    } else {
      session.appliedModeId = modeId;
    }

    let effectiveModel = session.appliedModelId ?? state?.models?.currentModelId;
    const requestedModel = configuration.model;
    if (requestedModel && requestedModel !== effectiveModel) {
      try {
        await session.client.request(
          'session/set_model',
          { sessionId: session.nativeSessionId, modelId: requestedModel },
          DEFAULT_REQUEST_TIMEOUT_MS,
          signal
        );
        effectiveModel = requestedModel;
      } catch {
        // A catalog can go stale between the render that populated the picker
        // and the send. The vendor's own current model is still a working turn,
        // and the echo below is what tells the user which one it is.
      }
      session.appliedModelId = effectiveModel;
    }

    const { effort: _requestedEffort, ...rest } = configuration;
    return {
      ...rest,
      ...(effectiveModel ? { model: effectiveModel } : {}),
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attaches the provenance the Logs page renders to the descriptor it describes. */
function withDiscoveryReport(record: CursorDiscoveryRecord): ExternalAgentRuntimeDescriptor {
  return {
    ...record.descriptor,
    discovery: {
      source: record.source,
      probedAtMs: record.probedAtMs,
      attempts: record.attempts,
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    },
  };
}

/**
 * Capabilities read off the handshake, never off a table.
 *
 * A table would be a claim about a build this runtime has not met. The
 * handshake is the build talking, so `resume`, `sessionListing` and `images`
 * come from `agentCapabilities`, and `modelCatalog` from whether a session
 * actually offered one.
 */
function capabilitiesFrom(probe: CursorProbe): ExternalAgentCapabilities {
  const agent = probe.initialize.agentCapabilities;
  return {
    ...CURSOR_BASE_CAPABILITIES,
    resume: agent?.loadSession === true,
    sessionListing: agent?.sessionCapabilities?.list !== undefined,
    images: agent?.promptCapabilities?.image === true,
    modelCatalog: (probe.session?.models?.availableModels?.length ?? 0) > 0,
  };
}

/**
 * The session's model list, as the vendor spelled it.
 *
 * `modelId` already carries its own parameterization —
 * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]` — so it is
 * passed through verbatim and never constructed. No count is asserted anywhere:
 * three different Cursor surfaces have reported three different totals, and the
 * only honest handling is to parse what arrives.
 */
function modelCatalogFrom(models: AcpModelState | undefined): ExternalAgentModel[] {
  const available = models?.availableModels ?? [];
  const current = models?.currentModelId;
  const catalog: ExternalAgentModel[] = [];
  for (const model of available) {
    if (catalog.length >= MODEL_CATALOG_LIMIT) break;
    const id = model.modelId;
    if (typeof id !== 'string' || id.length === 0) continue;
    catalog.push({
      id,
      ...(typeof model.name === 'string' && model.name.length > 0
        ? { displayName: model.name }
        : {}),
      ...(id === current ? { isDefault: true } : {}),
    });
  }
  return catalog;
}

function buildPromptBlocks(input: ExternalAgentStartTurnInput) {
  return [
    { type: 'text', text: input.params.input },
    ...(input.params.attachments ?? []).map((attachment) => ({
      type: 'image',
      mimeType: attachment.mimeType,
      data: attachment.bytesBase64,
    })),
  ];
}

/** Reads a whole JSON document off a short-lived process's stdout. */
async function readJsonDocument(
  managed: ExternalAgentManagedProcess,
  signal: AbortSignal
): Promise<unknown> {
  const lines: string[] = [];
  for (let index = 0; index < 256; index += 1) {
    const read = await managed.stdout.next(HANDSHAKE_TIMEOUT_MS, signal);
    if (read.kind !== 'line') break;
    lines.push(read.line);
  }
  if (lines.length === 0) return undefined;
  try {
    return JSON.parse(lines.join('\n'));
  } catch {
    return undefined;
  }
}

/**
 * Keyed, because an email is not enough entropy to hash.
 *
 * A plain `sha256(email)` crossing to the hub is not an opaque identifier — it
 * is something anyone holding it can test a guessed address against offline,
 * which recovers exactly the personal data leaving the address behind was meant
 * to protect. An HMAC under a key that never leaves this machine keeps the value
 * stable and comparable while making it meaningless to anyone who did not
 * compute it. No key, no fingerprint.
 */
function fingerprintAccount(email: string): string | undefined {
  const key = hostLocalDigestKey();
  if (!key) return undefined;
  return createHmac('sha256', key).update(`cursor:${email}`).digest('hex').slice(0, 32);
}
