/**
 * The Codex `app-server` adapter — the first real one.
 *
 * Codex went first because `app-server` is the only surface of the three
 * vendors carrying a genuine bidirectional approval protocol, so building it
 * first forced the approval path to be real before adapters that were assumed
 * unable to use it got a vote on the shape of the contract.
 *
 * Process policy is the adapter's, not the supervisor's: `app-server` is a
 * persistent stateful JSON-RPC service, so this keeps one process per session
 * for the session's life. A print-mode vendor would be per-invocation and a
 * stream-input one would be per-turn; none of that is baked into the layer
 * above.
 *
 * Deliberately **not** used: `codex exec --json`, a degraded batch mode with no
 * approvals, and `codex mcp-server`, which would make MangoStudio the loop owner
 * and invert the ownership model the whole cycle exists to establish.
 */

import { createHmac } from 'node:crypto';
import type {
  ExternalAgentAttachment,
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
  ExternalAgentOpenedSession,
  ExternalAgentOpenSessionInput,
  ExternalAgentStartTurnInput,
  ExternalAgentSteerInput,
  ExternalAgentSteerOutcome,
  ExternalAgentTurnStream,
} from '../adapter';
import { ExternalAgentAdapterError, toExternalAgentError } from '../errors';
import { hostLocalDigestKey } from '../isolation';
import {
  JsonRpcCallError,
  type JsonRpcHandlers,
  type JsonRpcServerRequestOutcome,
  StdioJsonRpcClient,
} from '../jsonrpc';
import type { ExternalAgentManagedProcess } from '../process';
import { TurnChannel } from '../turn-channel';
import { type CodexRequestApproval, planCodexServerRequest } from './approvals';
import {
  buildSupportedConfigurations,
  encodeApprovalPolicy,
  encodeApprovalsReviewer,
  unsupportedConfigurations,
} from './permissions';
import {
  CODEX_LOGIN_COMMAND,
  CODEX_OPT_OUT_NOTIFICATION_METHODS,
  CODEX_OPT_OUT_NOTIFICATION_PREFIXES,
  MINIMUM_CODEX_VERSION,
} from './pinned';
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse';
import type { Model } from './protocol/v2/Model';
import type { ModelListResponse } from './protocol/v2/ModelListResponse';
import type { PermissionProfileListResponse } from './protocol/v2/PermissionProfileListResponse';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { TurnStartParams } from './protocol/v2/TurnStartParams';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';
import type { TurnSteerParams } from './protocol/v2/TurnSteerParams';
import type { TurnSteerResponse } from './protocol/v2/TurnSteerResponse';
import { CodexTurnReducer, codexErrorCode } from './reducer';
import { encodeThreadSandboxMode, encodeTurnSandboxPolicy } from './sandbox';
import { isCodexVersionSupported, parseCodexVersion, requireCodexVersion } from './version';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;

/** How the shared JSON-RPC client names this peer in timeouts and teardowns. */
const CODEX_PEER_NAME = 'Codex app-server';

/** Parsed once: every gate compares structures rather than re-parsing a string. */
const MINIMUM_CODEX_VERSION_PARSED = requireCodexVersion(MINIMUM_CODEX_VERSION);

/**
 * How many `model/list` pages discovery will walk.
 *
 * The catalog is bounded at 256 entries by the contract, and a page is server-
 * sized, so this only exists so a server that returned a `nextCursor` forever
 * could not turn discovery into an unbounded loop.
 */
const MODEL_PAGE_LIMIT = 8;
const MODEL_CATALOG_LIMIT = 256;

/**
 * Notifications tolerated between `turn/start` being sent and its result naming
 * the turn. Ordering says there should be none; the buffer exists so that if
 * the vendor ever reorders, events are late rather than lost.
 */
const PRE_BIND_BUFFER_LIMIT = 64;

/**
 * What `app-server` genuinely supports, as opposed to what the neutral contract
 * has room for. Everything here was observed on a live 0.147.0, and the four
 * opportunistic capabilities stay false until their own plans land — a flag
 * cannot disagree with an implementation, because the registry's conformance
 * check derives the optional ones from whether the member exists.
 */
const CODEX_CAPABILITIES: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  reasoningStream: true,
  interactiveApprovals: true,
  resume: true,
  modelCatalog: true,
  images: true,
  usageReporting: true,
  cancellation: true,
  steering: true,
};

interface PendingApproval {
  readonly approval: CodexRequestApproval;
  settle(outcome: JsonRpcServerRequestOutcome): void;
}

/**
 * The one turn a session may have in flight.
 *
 * Singular because the supervisor enforces it, and holding it here rather than
 * in a map keyed by the vendor's turn id removes the window between sending
 * `turn/start` and learning what Codex called the turn.
 */
interface ActiveTurn {
  readonly handle: string;
  readonly channel: TurnChannel<ExternalAgentEvent>;
  /** Set once `turn/start` answers. Until then, notifications buffer. */
  reducer?: CodexTurnReducer;
  turnId?: string;
  /**
   * Set by `cancel` — including when it arrives before Codex has named the
   * turn, which is the case `turnId` alone cannot express.
   */
  cancelled?: boolean;
  buffered: Array<{ method: string; params: unknown }>;
}

interface CodexSession {
  readonly client: StdioJsonRpcClient;
  readonly process: ExternalAgentManagedProcess;
  threadId: string;
  /** Approvals awaiting `respond`, keyed by the vendor's own JSON-RPC request id. */
  readonly approvals: Map<string, PendingApproval>;
  activeTurn?: ActiveTurn;
  /**
   * Serializes `steer` calls against this session.
   *
   * Two distinct steers — different `clientMessageId`s, both addressed to the
   * same running turn — would otherwise both read `activeTurn.turnId` before
   * either request resolves. The first to land can replace that id with a
   * continuation id, leaving the second still holding the one that request
   * started with: sent, it names a turn Codex already moved past. Chaining
   * every steer off the one before it is what makes each read the id the
   * previous steer actually left behind, not the one that was live when it
   * was called.
   */
  steerChain: Promise<unknown>;
}

export class CodexAppServerAdapter implements ExternalAgentAdapter {
  readonly targetId: ExternalAgentTargetId = 'codex';

  /**
   * Documented Codex variables the child is allowed to inherit.
   *
   * `CODEX_HOME` is where the CLI keeps its own credentials and configuration;
   * without it a user who relocated that directory would appear signed out. The
   * base allowlist in `process.ts` supplies everything else, and nothing a hub
   * request carries can add to this list.
   */
  readonly vendorEnvironmentKeys = ['CODEX_HOME'] as const;

  readonly #sessions = new Map<string, CodexSession>();
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async discover(context: ExternalAgentAdapterContext): Promise<ExternalAgentRuntimeDescriptor> {
    const version = await this.#readVersion(context);
    if (!version) {
      return {
        targetId: this.targetId,
        installed: false,
        authState: 'unknown',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: [],
        loginCommand: CODEX_LOGIN_COMMAND,
      };
    }

    // Codex is the one vendor where the version number is still the gate, and
    // that is a statement about `app-server` rather than a preference. Its
    // `initialize` carries no protocol version, and the calls discovery makes —
    // `account/read`, `model/list`, `permissionProfile/list` — cover none of the
    // turn surface, so a successful probe would prove nothing about
    // `thread/start` or `turn/start`. Cursor and Claude both have a probe that
    // covers what they depend on and are gated on that instead; here there is
    // nothing to ask, so the pin answers.
    //
    // Applying it at discovery rather than only at `openSession` is what keeps a
    // too-old binary whose `account/read` still answers from producing a
    // selectable configuration whose failure surfaces after someone sends a
    // message. It also skips launching an `app-server` this adapter has already
    // decided not to drive.
    if (!isCodexVersionSupported(parseCodexVersion(version), MINIMUM_CODEX_VERSION_PARSED)) {
      return {
        targetId: this.targetId,
        installed: true,
        version,
        requiredVersion: MINIMUM_CODEX_VERSION,
        unavailableReason: 'version-unsupported',
        authState: 'unknown',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: unsupportedConfigurations(
          'externalAgents.unsupported.codexVersionTooOld'
        ),
      };
    }

    // Everything past this point needs a live `app-server`, which is exactly
    // why discovery is the runtime's job and not the hub's: it is a bounded
    // subprocess, not a file read.
    let launched: { client: StdioJsonRpcClient; process: ExternalAgentManagedProcess } | undefined;
    try {
      launched = await this.#launch(context, {
        onNotification: () => undefined,
        // Discovery runs no turn, so there is nobody to ask. Anything that
        // would have become an approval is declined rather than left hanging.
        onServerRequest: (method, params, requestId) => {
          const plan = planCodexServerRequest(method, params, requestId, this.#now());
          return plan.outcome === 'refuse'
            ? { error: { code: plan.code, message: plan.message } }
            : {
                error: {
                  code: -32603,
                  message: 'Codex discovery cannot answer an approval request.',
                },
              };
        },
      });
      const client = launched.client;
      const [account, models, profiles] = await Promise.all([
        this.#tryRequest<GetAccountResponse>(client, 'account/read', {}, context.signal),
        this.#readModelCatalog(client, context.signal),
        this.#tryRequest<PermissionProfileListResponse>(
          client,
          'permissionProfile/list',
          {},
          context.signal
        ),
      ]);

      const signedIn = account?.account != null;
      return {
        targetId: this.targetId,
        installed: true,
        version,
        authState: account === undefined ? 'unknown' : signedIn ? 'signed-in' : 'signed-out',
        ...(signedIn ? {} : { loginCommand: CODEX_LOGIN_COMMAND }),
        capabilities: CODEX_CAPABILITIES,
        supportedConfigurations: buildSupportedConfigurations(profiles?.data ?? []),
        ...(models ? { models } : {}),
        ...(account?.account ? { account: mapAccount(account) } : {}),
      };
    } finally {
      await launched?.client.close().catch(() => undefined);
      await launched?.process.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
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

    const session: CodexSession = {
      client: launched.client,
      process: launched.process,
      threadId: '',
      approvals: new Map(),
      steerChain: Promise.resolve(),
    };
    // Registered before `thread/start` so a server request arriving during the
    // handshake finds a session to refuse against rather than a missing one.
    this.#sessions.set(sessionId, session);

    try {
      const started = await this.#startOrResumeThread(launched.client, params, context);
      session.threadId = started.thread.thread.id;
      return {
        nativeSessionId: started.thread.thread.id,
        resumed: started.resumed,
        ...(started.fallbackReason ? { fallbackReason: started.fallbackReason } : {}),
        // The **echo**, not the request. Codex's config layers may have
        // overridden the model or the effort, and a UI showing what was asked
        // for rather than what is in force is showing a guess.
        effectiveConfiguration: readEffectiveConfiguration(started.thread, params.configuration),
        capabilities: CODEX_CAPABILITIES,
      };
    } catch (error) {
      this.#sessions.delete(sessionId);
      await launched.client.close().catch(() => undefined);
      await launched.process.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Starts a turn and returns its stream synchronously.
   *
   * The handle is the hub's own `clientMessageId` rather than Codex's turn id,
   * because the interface hands back a stream with `nativeTurnId` already on it
   * while `turn/start`'s result — where Codex's id first appears — is still in
   * flight. Using the hub's id makes the handle stable across the retry the
   * supervisor already deduplicates by, and Codex's real turn id is kept on the
   * session for `turn/interrupt` and for correlating notifications.
   */
  startTurn(input: ExternalAgentStartTurnInput): ExternalAgentTurnStream {
    const session = this.#requireSession(input.params.sessionId);
    const handle = input.params.clientMessageId;
    const channel = new TurnChannel<ExternalAgentEvent>();
    const active: ActiveTurn = { handle, channel, buffered: [] };
    session.activeTurn = active;

    const run = async (): Promise<void> => {
      try {
        const started = await session.client.request<TurnStartResponse>(
          'turn/start',
          buildTurnStartParams(session.threadId, input),
          DEFAULT_REQUEST_TIMEOUT_MS
          // Deliberately **no** abort signal. The per-turn signal is aborted by
          // `cancel`, and aborting this call would only stop MangoStudio
          // listening for the id — Codex would keep running the turn it already
          // accepted, executing commands nobody can see or stop. Waiting for the
          // id is what makes `turn/interrupt` reachable; `close()` and the
          // request timeout still bound the wait.
        );
        active.turnId = started.turn.id;
        // A cancel that arrived before the id did: the interrupt was impossible
        // then and is possible now. Nothing else about the turn is set up,
        // because the channel is already finished and nobody is listening.
        if (active.cancelled) {
          await this.#interruptTurn(session, started.turn.id);
          return;
        }
        active.reducer = new CodexTurnReducer(started.turn.id, this.#now);
        const buffered = active.buffered;
        active.buffered = [];
        for (const pending of buffered) {
          this.#applyNotification(session, active, pending.method, pending.params);
        }
      } catch (error) {
        if (active.cancelled) return;
        channel.push({ type: 'error', error: toExternalAgentError(error, 'codex-turn-start') });
        channel.finish();
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
   * parked on — but every failure still has to arrive as a **rejection**. The
   * interface promises a `Promise<void>`, and a caller that attaches `.catch`
   * without awaiting would miss a synchronous throw entirely.
   */
  respond(input: ExternalAgentApprovalResponseInput): Promise<void> {
    try {
      this.#respond(input);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #respond(input: ExternalAgentApprovalResponseInput): void {
    const session = this.#requireSession(input.sessionId);
    const pending = session.approvals.get(input.requestId);
    if (!pending) {
      throw new ExternalAgentAdapterError(
        'codex-approval-unknown',
        `Codex approval "${input.requestId}" is no longer awaiting an answer.`
      );
    }
    session.approvals.delete(input.requestId);

    // `expiresAtMs` is a promise made to the person looking at the card, and it
    // has to bind the answer as well as the wait. Nothing else enforces it: the
    // supervisor reads the deadline only to decide how long to suspend its idle
    // timeout, so a reply delayed past it — by the network, or by a second
    // approval holding the turn open — would otherwise still be encoded and
    // sent, granting an action whose card already said it could not be answered.
    // Refused rather than converted into a denial: choosing a decline option on
    // the user's behalf would be MangoStudio answering a vendor question, and
    // the exchange the vendor is blocked on is settled either way.
    if (this.#now() >= pending.approval.request.expiresAtMs) {
      pending.settle({
        error: { code: -32800, message: 'The approval expired before an answer arrived.' },
      });
      session.activeTurn?.channel.push({
        type: 'approval_resolved',
        requestId: input.requestId,
        decision: { optionId: input.optionId, source: 'expired' },
      });
      throw new ExternalAgentAdapterError(
        'codex-approval-expired',
        `Codex approval "${input.requestId}" expired before this answer arrived.`
      );
    }

    let result: unknown;
    try {
      result = pending.approval.encode(input.optionId);
    } catch (error) {
      // The rejection is the vendor's contract talking, so it has to reach the
      // caller — but Codex is still blocked on a reply, and leaving it that way
      // would hang the turn rather than fail the call.
      pending.settle({
        error: { code: -32602, message: 'The selected option is not one Codex offered.' },
      });
      throw error;
    }
    pending.settle({ result });
    session.activeTurn?.channel.push({
      type: 'approval_resolved',
      requestId: input.requestId,
      decision: { optionId: input.optionId, source: 'user' },
    });
  }

  /**
   * Stop the turn, including one Codex has not named yet.
   *
   * The pre-bind case is the one worth spelling out. `startTurn` returns its
   * stream before `turn/start` answers, so a cancel can land while the vendor
   * has accepted the turn and MangoStudio does not yet know its id. Finishing
   * the local channel there would abandon a live turn: Codex keeps executing
   * commands and writing files with nothing rendering it and nothing able to
   * stop it. Marking the turn cancelled hands the interrupt to whichever side
   * learns the id first — here if it is already known, `startTurn`'s own
   * continuation if it is not.
   */
  async cancel(input: ExternalAgentCancelInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return;
    this.#releaseApprovals(session, 'The turn was cancelled.');

    const active = session.activeTurn;
    if (active) active.cancelled = true;
    if (active?.turnId) await this.#interruptTurn(session, active.turnId);
    if (active) {
      active.channel.finish();
      session.activeTurn = undefined;
    }
  }

  /** `turn/interrupt`, best effort: a failure here must not fail a cancel. */
  async #interruptTurn(session: CodexSession, turnId: string): Promise<void> {
    if (!session.threadId) return;
    await session.client
      .request('turn/interrupt', { threadId: session.threadId, turnId }, SHUTDOWN_GRACE_MS)
      .catch(() => undefined);
  }

  /**
   * `turn/steer`, Codex's own client operation for redirecting a running turn.
   *
   * Queued behind {@link CodexSession.steerChain} rather than run directly:
   * two distinct steers issued close together — different `clientMessageId`s,
   * both addressed to the turn that is live right now — would otherwise both
   * read `activeTurn.turnId` before either request resolved, and the first to
   * land can replace that id with a continuation id the second never saw.
   * Chaining makes the second wait for the first's outcome and read
   * `turnId` fresh, so it always addresses the turn Codex is actually running.
   */
  steer(input: ExternalAgentSteerInput): Promise<ExternalAgentSteerOutcome> {
    const session = this.#requireSession(input.sessionId);
    const run = session.steerChain.then(() => this.#steerNow(session, input));
    // The chain must keep moving whether this attempt was refused, accepted or
    // threw — otherwise one failure would wedge every steer queued behind it.
    session.steerChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * `input.nativeTurnId` is the handle `startTurn` returned — the hub's own
   * `clientMessageId` for the turn, not Codex's turn id — because that is the
   * only turn identity the hub was ever given. Codex's own id lives in
   * `active.turnId` and is what `expectedTurnId` has to carry; the precondition
   * fails whenever it does not name the turn Codex is currently running, which
   * is exactly the "steer a turn that just finished" race the caller can hit
   * legitimately.
   *
   * The handle is checked locally, before any request: a turn Codex has not
   * named yet, one that was cancelled, or one that no longer matches what the
   * hub thinks is running are all "nothing to steer right now" and cost nothing
   * to refuse without a round trip.
   */
  async #steerNow(
    session: CodexSession,
    input: ExternalAgentSteerInput
  ): Promise<ExternalAgentSteerOutcome> {
    const active = session.activeTurn;
    if (!active || active.cancelled || active.handle !== input.nativeTurnId || !active.turnId) {
      return { accepted: false, reasonCode: 'turn-already-completed' };
    }
    // The shared JSON-RPC client answers one message at a time and does not
    // read the next line until a server→client request is answered — so a
    // `turn/steer` sent while Codex is blocked on an approval could never see
    // its own response until that approval resolves. Refused here, for the
    // same reason `turn-not-steerable` exists: this turn cannot take new
    // input right now.
    if (session.approvals.size > 0) {
      return { accepted: false, reasonCode: 'turn-not-steerable' };
    }

    try {
      const response = await session.client.request<TurnSteerResponse>(
        'turn/steer',
        {
          threadId: session.threadId,
          expectedTurnId: active.turnId,
          clientUserMessageId: input.clientMessageId,
          input: [{ type: 'text', text: input.input, text_elements: [] }],
        } satisfies TurnSteerParams,
        DEFAULT_REQUEST_TIMEOUT_MS
      );
      // Codex may continue the turn under a new id. A later interrupt or steer
      // has to address the one it is actually running now.
      if (session.activeTurn === active) {
        active.turnId = response.turnId;
        active.reducer?.adoptTurnId(response.turnId);
      }
      return { accepted: true };
    } catch (error) {
      const reason = steerRejectionReason(error, active, session);
      if (reason) return { accepted: false, reasonCode: reason };
      throw error;
    }
  }

  async close(input: ExternalAgentCloseInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return;
    this.#sessions.delete(input.sessionId);
    this.#releaseApprovals(session, 'The session was closed.');
    session.activeTurn?.channel.finish();
    session.activeTurn = undefined;
    await session.client.close().catch(() => undefined);
    await session.process.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
  }

  /** Answers every blocked server request so no vendor call outlives its turn. */
  #releaseApprovals(session: CodexSession, message: string): void {
    for (const [requestId, pending] of [...session.approvals]) {
      session.approvals.delete(requestId);
      pending.settle({ error: { code: -32800, message } });
    }
  }

  #requireSession(sessionId: string): CodexSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new ExternalAgentAdapterError(
        'codex-session-missing',
        `Codex session "${sessionId}" is not open.`
      );
    }
    return session;
  }

  #onNotification(sessionId: string, method: string, params: unknown): void {
    const session = this.#sessions.get(sessionId);
    const active = session?.activeTurn;
    if (!session || !active) return;
    if (!active.reducer) {
      // Ordering says this cannot happen: `turn/start`'s result precedes every
      // notification for that turn. The bound buffer is here so that if the
      // vendor ever changes that, events arrive late rather than vanish.
      if (active.buffered.length < PRE_BIND_BUFFER_LIMIT) {
        active.buffered.push({ method, params });
      }
      return;
    }
    this.#applyNotification(session, active, method, params);
  }

  #applyNotification(
    session: CodexSession,
    active: ActiveTurn,
    method: string,
    params: unknown
  ): void {
    const reducer = active.reducer;
    if (!reducer) return;
    const reduction = reducer.reduce(method, params);
    for (const event of reduction.events) active.channel.push(event);
    if (reduction.finished) {
      active.channel.finish();
      if (session.activeTurn === active) session.activeTurn = undefined;
    }
  }

  async #onServerRequest(
    sessionId: string,
    method: string,
    params: unknown,
    requestId: string
  ): Promise<JsonRpcServerRequestOutcome> {
    const plan = planCodexServerRequest(method, params, requestId, this.#now());
    if (plan.outcome === 'refuse') {
      return { error: { code: plan.code, message: plan.message } };
    }
    const session = this.#sessions.get(sessionId);
    const active = session?.activeTurn;
    if (!session || !active) {
      return { error: { code: -32603, message: 'No live MangoStudio turn to ask.' } };
    }

    // The vendor stays blocked here on purpose: this promise resolves when
    // `respond` arrives, when the turn is cancelled, or when the session
    // closes. `expiresAtMs` on the request is what stops it being forever, and
    // the supervisor suspends its idle timeout for exactly that long.
    return await new Promise<JsonRpcServerRequestOutcome>((settle) => {
      session.approvals.set(requestId, { approval: plan, settle });
      active.channel.push({ type: 'approval_requested', request: plan.request });
    });
  }

  async #assertSupportedVersion(context: ExternalAgentAdapterContext): Promise<void> {
    const raw = await this.#readVersion(context);
    const observed = raw ? parseCodexVersion(raw) : undefined;
    if (isCodexVersionSupported(observed, MINIMUM_CODEX_VERSION_PARSED)) return;
    throw new ExternalAgentAdapterError(
      'codex-version-unsupported',
      raw
        ? `Codex ${raw} predates the ${MINIMUM_CODEX_VERSION} this runtime speaks. Upgrade the Codex CLI.`
        : 'The Codex CLI did not report a version this runtime could read.'
    );
  }

  /**
   * `codex --version` off the executable the runtime scanner resolved.
   *
   * Not `bunx`, and not a package manager: this machine's Codex may have come
   * from npm, from Bun, from Homebrew or as a downloaded binary, and all four
   * answer `--version` the same way. `initialize`'s result carries no protocol
   * version, so this is the only thing that can gate the vendored contract.
   */
  async #readVersion(context: ExternalAgentAdapterContext): Promise<string | undefined> {
    const executable = context.executablePath;
    if (!executable) return undefined;
    const managed = context.spawn({ argv: [executable, '--version'] });
    try {
      const read = await managed.stdout.next(HANDSHAKE_TIMEOUT_MS, context.signal);
      return read.kind === 'line' && read.line.trim().length > 0 ? read.line.trim() : undefined;
    } catch {
      return undefined;
    } finally {
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
  }

  async #launch(
    context: ExternalAgentAdapterContext,
    handlers: JsonRpcHandlers
  ): Promise<{ client: StdioJsonRpcClient; process: ExternalAgentManagedProcess }> {
    const executable = context.executablePath;
    if (!executable) {
      throw new ExternalAgentAdapterError('codex-not-installed', 'The Codex CLI was not found.');
    }
    // stdio JSONL, never the WebSocket listener: the supervisor owns the pipe,
    // the byte caps and the process tree, and a listening socket would be a
    // second way in that none of those cover.
    const managed = context.spawn({ argv: [executable, 'app-server'] });
    const client = new StdioJsonRpcClient(managed, handlers, CODEX_PEER_NAME);
    try {
      await client.request(
        'initialize',
        {
          clientInfo: { name: 'mangostudio', title: 'MangoStudio', version: '1' },
          capabilities: {
            optOutNotificationMethods: optOutNotificationMethods(),
            // Stated rather than inherited. The v2 `thread/*`, `turn/*` and
            // `item/*` surface this adapter uses needs no experimental opt-in —
            // verified against a live 0.147.0 — and opting in would widen the
            // parse surface to methods nothing here handles.
            experimentalApi: false,
            requestAttestation: false,
          },
        },
        HANDSHAKE_TIMEOUT_MS,
        context.signal
      );
      await client.notify('initialized', {});
      return { client, process: managed };
    } catch (error) {
      await client.close().catch(() => undefined);
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
      throw error;
    }
  }

  async #startOrResumeThread(
    client: StdioJsonRpcClient,
    params: ExternalAgentOpenSessionInput['params'],
    context: ExternalAgentAdapterContext
  ): Promise<{ thread: ThreadStartResponse; resumed: boolean; fallbackReason?: string }> {
    const request = buildThreadStartParams(params);
    if (!params.resumeRef) {
      const started = await client.request<ThreadStartResponse>(
        'thread/start',
        request,
        DEFAULT_REQUEST_TIMEOUT_MS,
        context.signal
      );
      return { thread: started, resumed: false };
    }

    try {
      const resumed = await client.request<ThreadStartResponse>(
        'thread/resume',
        { ...request, threadId: params.resumeRef },
        DEFAULT_REQUEST_TIMEOUT_MS,
        context.signal
      );
      return { thread: resumed, resumed: true };
    } catch (error) {
      // `strict` exists so a caller that asked for *this* session is not
      // silently handed a fresh one. Plan 013 adopts a session the user picked
      // by name; quietly starting a different thread there is the bug the mode
      // was added to prevent.
      if (params.resumeMode === 'strict') {
        throw new ExternalAgentAdapterError(
          'codex-resume-failed',
          `Codex could not resume thread "${params.resumeRef}": ${errorText(error)}`
        );
      }
      const started = await client.request<ThreadStartResponse>(
        'thread/start',
        request,
        DEFAULT_REQUEST_TIMEOUT_MS,
        context.signal
      );
      return { thread: started, resumed: false, fallbackReason: errorText(error) };
    }
  }

  /**
   * The whole model catalog, not just its first page.
   *
   * `model/list` is cursor-paginated with a server-chosen page size, so reading
   * `data` once and stopping silently truncates the selector for anyone whose
   * Codex offers more models than one page holds — and a missing model is
   * indistinguishable from an unsupported one to the person looking for it.
   *
   * Bounded three ways: the vendor's own cursor, the contract's 256-entry
   * catalog cap, and a page ceiling, so a server that always returns a cursor
   * cannot hold discovery open. A page that fails mid-walk keeps what was
   * already read rather than discarding the catalog.
   */
  async #readModelCatalog(
    client: StdioJsonRpcClient,
    signal: AbortSignal
  ): Promise<ExternalAgentModel[] | undefined> {
    const models: ExternalAgentModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MODEL_PAGE_LIMIT; page += 1) {
      const response: ModelListResponse | undefined = await this.#tryRequest<ModelListResponse>(
        client,
        'model/list',
        cursor === null ? {} : { cursor },
        signal
      );
      if (!response) return models.length > 0 ? models : undefined;
      for (const model of response.data) {
        if (models.length >= MODEL_CATALOG_LIMIT) return models;
        models.push(mapModel(model));
      }
      cursor = response.nextCursor;
      if (cursor === null) break;
    }
    return models;
  }

  /** A discovery call that may legitimately be absent rather than fatal. */
  async #tryRequest<T>(
    client: StdioJsonRpcClient,
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<T | undefined> {
    try {
      return await client.request<T>(method, params, DEFAULT_REQUEST_TIMEOUT_MS, signal);
    } catch {
      return undefined;
    }
  }
}

/**
 * The notification names in the pinned contract that belong to an opted-out
 * family, listed so the opt-out can be exact — the vendor matches these
 * literally and has no wildcard form. `codex-protocol-pin.test.ts` holds this
 * against the generated `ServerNotification` union, so a family that grows a
 * member fails the build rather than silently starting to arrive.
 */
export const CODEX_OPT_OUT_FAMILY_METHODS: readonly string[] = [
  'app/list/updated',
  'remoteControl/status/changed',
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
];

/** Every opted-out method name, sorted, as `initialize` wants them. */
export function optOutNotificationMethods(
  familyMethods: readonly string[] = CODEX_OPT_OUT_FAMILY_METHODS
): string[] {
  const named = new Set(CODEX_OPT_OUT_NOTIFICATION_METHODS);
  for (const method of familyMethods) {
    if (CODEX_OPT_OUT_NOTIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix))) {
      named.add(method);
    }
  }
  return [...named].sort();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Distinguishes Codex's two steer refusals from an ordinary failure.
 *
 * `activeTurnNotSteerable` is structured — the vendor names the reason — so it
 * is read straight off the error's `data`. A precondition failure on
 * `expectedTurnId` is not: nothing in the wire protocol says "that was the
 * wrong turn," so it has to be read back off the adapter's own bookkeeping,
 * which the request above kept live across the call. `undefined` means
 * neither explains the failure, and the caller re-throws rather than guess.
 */
function steerRejectionReason(
  error: unknown,
  active: ActiveTurn,
  session: CodexSession
): 'turn-not-steerable' | 'turn-already-completed' | undefined {
  if (error instanceof JsonRpcCallError) {
    const info = codexErrorInfoFrom(error.data);
    if (info !== undefined && codexErrorCode(info) === 'activeTurnNotSteerable') {
      return 'turn-not-steerable';
    }
  }
  if (session.activeTurn !== active || active.cancelled) return 'turn-already-completed';
  return undefined;
}

/** `error.data` is not pinned for a failed request; either shape is read. */
function codexErrorInfoFrom(data: unknown): unknown {
  if (data && typeof data === 'object' && 'codexErrorInfo' in data) {
    return (data as { codexErrorInfo?: unknown }).codexErrorInfo;
  }
  return data;
}

function buildThreadStartParams(
  params: ExternalAgentOpenSessionInput['params']
): ThreadStartParams {
  const { configuration } = params;
  return {
    cwd: params.workspacePath,
    // The STRING form. `turn/start` takes an object under a different name;
    // see `sandbox.ts` for why the two encoders cannot be swapped.
    sandbox: encodeThreadSandboxMode(configuration.level),
    approvalPolicy: encodeApprovalPolicy(configuration.level),
    approvalsReviewer: encodeApprovalsReviewer(configuration.routing),
    ...(configuration.model ? { model: configuration.model } : {}),
  };
}

function buildTurnStartParams(
  threadId: string,
  input: ExternalAgentStartTurnInput
): TurnStartParams {
  const { configuration } = input.params;
  return {
    threadId,
    clientUserMessageId: input.params.clientMessageId,
    input: [
      { type: 'text', text: input.params.input, text_elements: [] },
      ...(input.params.attachments ?? []).map(toImageInput),
    ],
    // The OBJECT form, under `sandboxPolicy`. Per-turn configuration is what
    // lets a permission change take effect without restarting the session.
    sandboxPolicy: encodeTurnSandboxPolicy(configuration.level, configuration.workspaceRoots),
    approvalPolicy: encodeApprovalPolicy(configuration.level),
    approvalsReviewer: encodeApprovalsReviewer(configuration.routing),
    ...(configuration.model ? { model: configuration.model } : {}),
    ...(configuration.effort ? { effort: configuration.effort } : {}),
  };
}

/**
 * Attachments cross as data URLs.
 *
 * `localImage` would be the cheaper form, but it names a path on the machine
 * running Codex, and the bytes came from the hub — which may be a different
 * machine entirely. Inlining them keeps the transport honest about where the
 * data actually is.
 */
function toImageInput(attachment: ExternalAgentAttachment) {
  return {
    type: 'image' as const,
    url: `data:${attachment.mimeType};base64,${attachment.bytesBase64}`,
  };
}

/**
 * The `thread/start` echo, which is what is actually in force.
 *
 * `workspaceRoots` comes from the request rather than the echo because the
 * response has no field for it at this pinned version: the supervisor
 * authorized those directories, so reporting them back is honest, while
 * reporting a model MangoStudio asked for but Codex overrode would not be.
 *
 * `effort` follows the echo in **both** directions, which is why it is removed
 * before being re-added. A model that applies no reasoning effort echoes
 * `reasoningEffort: null`, and merely declining to overwrite would leave the
 * requested value standing — reporting an effort as active because it was asked
 * for, which is exactly the guess this function exists to avoid, and one that
 * would then be persisted and carried into the next turn.
 */
function readEffectiveConfiguration(
  response: ThreadStartResponse,
  requested: ExternalAgentConfiguration
): ExternalAgentConfiguration {
  const { effort: _requestedEffort, ...rest } = requested;
  return {
    ...rest,
    model: response.model,
    ...(response.reasoningEffort ? { effort: response.reasoningEffort } : {}),
  };
}

function mapModel(model: Model): ExternalAgentModel {
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    hidden: model.hidden,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
      id: effort.reasoningEffort,
      description: effort.description,
    })),
    defaultReasoningEffort: model.defaultReasoningEffort,
  };
}

/**
 * A display label and a plan type — never the raw email.
 *
 * `account/read` returns the signed-in address, which is personal data with no
 * reason to leave the runtime. What crosses instead is a label the owner can
 * recognize plus a fingerprint whose only job is to notice that the account
 * behind a session changed.
 */
function mapAccount(response: GetAccountResponse) {
  const account = response.account;
  if (account?.type === 'chatgpt') {
    const fingerprint = account.email ? fingerprintAccount(account.email) : undefined;
    return {
      label: 'ChatGPT',
      ...(account.planType ? { planType: String(account.planType) } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    };
  }
  if (account?.type === 'apiKey') return { label: 'API key' };
  if (account?.type === 'amazonBedrock') return { label: 'Amazon Bedrock' };
  return { label: 'Signed in' };
}

/**
 * Keyed, because an email is not enough entropy to hash.
 *
 * A plain `sha256(email)` crossing to the hub is not an opaque identifier — it
 * is something anyone holding it can test a guessed address against offline,
 * which recovers exactly the personal data leaving the address behind was
 * meant to protect. An HMAC under a key that never leaves this machine keeps
 * the value stable and comparable while making it meaningless to anyone who
 * did not compute it.
 *
 * No key, no fingerprint. Falling back to an unkeyed digest would ship the
 * weaker thing under the stronger name, and the field is optional precisely so
 * that omitting it is available.
 */
function fingerprintAccount(email: string): string | undefined {
  const key = hostLocalDigestKey();
  if (!key) return undefined;
  return createHmac('sha256', key).update(`codex:${email}`).digest('hex').slice(0, 32);
}
