/**
 * The Claude Code adapter — one process per turn.
 *
 * Process policy is the adapter's, and Claude's is the opposite of Codex's.
 * `app-server` is a persistent stateful service, so that adapter keeps one
 * process for a session's life. `claude --print` is a batch invocation that
 * reads a prompt, runs a turn and exits, and continuity comes from a session id
 * on disk rather than from a pipe staying open. So a session here owns no
 * process at all: it owns a **session id**, and each turn spawns, streams and
 * reaps its own.
 *
 * That has three consequences worth stating where they are implemented.
 *
 * - **`openSession` starts nothing.** It mints the session id — Claude accepts
 *   `--session-id <uuid>` and echoes it back — so the hub has a resumable handle
 *   before any tokens are spent. A resume reference is adopted rather than
 *   verified, because verifying it would cost a process launch per send.
 * - **The prompt travels on stdin.** `--input-format stream-json` is the
 *   documented programmatic input, and it keeps the prompt out of argv, which is
 *   world-readable in `ps` on every platform this runs on. A conversation is
 *   exactly the kind of thing that must not appear in a process listing.
 * - **Cancellation is SIGTERM, and exit 143 is success.** The CLI aborts the
 *   turn, kills the process tree of any running Bash command, runs `SessionEnd`
 *   hooks and exits 128 + SIGTERM. A supervisor reading that as a crash would
 *   put a failure in the transcript for something the user asked for.
 *
 * Deliberately **not** used: `--bare`, which would make the turn deterministic
 * but never reads OAuth credentials or the system keychain — it authenticates
 * from `ANTHROPIC_API_KEY`, from an `apiKeyHelper` passed through `--settings`,
 * or from a third-party provider's own credentials. None of those is the
 * subscription sign-in this adapter hosts, so for a subscription-backed account
 * determinism and authentication are mutually exclusive, and v1 takes
 * authentication — the runtime host's own `~/.claude` is inherited, hooks,
 * plugins, MCP servers and all. That is a limit, not a feature, and it is
 * disclosed rather than papered over.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  ExternalAgentOpenedSession,
  ExternalAgentOpenSessionInput,
  ExternalAgentStartTurnInput,
  ExternalAgentTurnStream,
} from '../adapter';
import { ExternalAgentAdapterError, toExternalAgentError } from '../errors';
import type { ExternalAgentManagedProcess } from '../process';
import { TurnChannel } from '../turn-channel';
import { CLAUDE_AUTH_UNKNOWN, type ClaudeAuthentication, parseClaudeAuthStatus } from './auth';
import {
  type ClaudeCliSurface,
  claudeAcceptedModes,
  isUsableClaudeCliSurface,
  missingClaudeCliFlags,
  parseClaudeCliSurface,
} from './cli-surface';
import { claudeEffortAccepted, claudeModelCatalog } from './models';
import {
  buildSupportedConfigurations,
  CLAUDE_UNSUPPORTED_REASON_KEYS,
  type ClaudeModeAvailability,
  claudeModeAccepted,
  claudePermissionMode,
  readAutoModeDisabled,
  unsupportedConfigurations,
} from './permissions';
import {
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_POST_RESULT_GRACE_MS,
  CLAUDE_SIGTERM_EXIT_CODE,
  CLAUDE_VENDOR_ENVIRONMENT_KEYS,
  claudeManagedSettingsPath,
  MINIMUM_CLAUDE_VERSION,
} from './pinned';
import { parseClaudeStreamLine } from './protocol';
import { type ClaudeRunInit, ClaudeTurnReducer } from './reducer';
import { isClaudeVersionSupported, parseClaudeVersion, requireClaudeVersion } from './version';

const PROBE_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * How long the stream may go quiet before the turn is abandoned.
 *
 * Generous, because a single Claude tool call can legitimately run for minutes
 * and the vendor emits nothing while it does. The supervisor's own idle and
 * hard-turn budgets sit above this; what this bounds is a process that stopped
 * writing without exiting, which neither of those would notice promptly.
 */
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Parsed once: every gate compares structures rather than re-parsing a string. */
const MINIMUM_CLAUDE_VERSION_PARSED = requireClaudeVersion(MINIMUM_CLAUDE_VERSION);

/**
 * What this adapter genuinely supports.
 *
 * Every opportunistic flag is false, and each one is a measured verdict rather
 * than an unimplemented stub:
 *
 * - `interactiveApprovals` — plain headless execution cannot deliver an
 *   answerable approval. An unmatched `Write` under the default mode produces a
 *   structured denial, a result listing it, exit 0 and no file; no stream
 *   control frame is offered to answer it. `--permission-prompt-tool` exists and
 *   could change that, and it is out of scope on purpose: hosting a permission
 *   prompt tool makes MangoStudio part of the authorization path for an agent it
 *   does not own, which needs authenticated request ids, replay protection,
 *   expiry, owner binding and a threat model of its own.
 * - `steering` — `--input-format stream-json` accepts a second message, but it
 *   runs as **its own turn**, with its own result. That is a queued follow-up,
 *   not same-turn steering.
 * - `sessionListing` — the internal JSONL lives under an encoded
 *   `~/.claude/projects/<cwd>/` path the vendor documents as subject to change.
 *   Parsing it would be reading another company's private format.
 * - `nativeReview`, `accountUsage` — no surface observed.
 */
const CLAUDE_CAPABILITIES: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  reasoningStream: true,
  resume: true,
  cancellation: true,
  usageReporting: true,
};

/**
 * The same set, with the one flag that depends on the build in front of us.
 *
 * `modelCatalog` was a constant `false` while `--model` was only known to
 * accept a value. The help now advertises which aliases it resolves, so the
 * answer is per-install: a build that states them has a catalog, and one that
 * does not keeps the picker hidden exactly as before.
 *
 * Derived in one place because **both** `discover` and `openSession` report
 * capabilities, and a session that disagreed with the descriptor it was chosen
 * from would offer a picker the hub never validated against — the same reason
 * Cursor derives its four flags from the live handshake rather than from a
 * constant.
 */
function claudeCapabilities(
  models: readonly ExternalAgentModel[] | undefined
): ExternalAgentCapabilities {
  return { ...CLAUDE_CAPABILITIES, modelCatalog: models !== undefined };
}

interface ClaudeSession {
  /** The vendor session id. Stable across turns; `--resume` echoes it back. */
  sessionId: string;
  readonly workspacePath: string;
  /** False until a turn has actually created the session on disk. */
  established: boolean;
  configuration: ExternalAgentConfiguration;
  availability: ClaudeModeAvailability;
  /**
   * `--effort`'s levels as this build declared them, read once when the session
   * opened rather than per turn.
   *
   * A sibling of `availability` rather than a field on it: that type answers
   * which *permission modes* this account may run, and effort is neither a
   * permission nor account-dependent.
   */
  readonly acceptedEfforts?: ReadonlySet<string>;
  activeTurn?: {
    readonly channel: TurnChannel<ExternalAgentEvent>;
    readonly reducer: ClaudeTurnReducer;
    process?: ExternalAgentManagedProcess;
    cancelled: boolean;
  };
}

export class ClaudeCodeAdapter implements ExternalAgentAdapter {
  readonly targetId: ExternalAgentTargetId = 'claude';
  readonly vendorEnvironmentKeys = CLAUDE_VENDOR_ENVIRONMENT_KEYS;

  readonly #sessions = new Map<string, ClaudeSession>();
  readonly #newSessionId: () => string;
  readonly #readManagedSettings: () => Promise<unknown>;

  constructor(
    options: {
      readonly newSessionId?: () => string;
      readonly readManagedSettings?: () => Promise<unknown>;
    } = {}
  ) {
    this.#newSessionId = options.newSessionId ?? randomUUID;
    this.#readManagedSettings = options.readManagedSettings ?? readManagedSettingsFile;
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
        loginCommand: CLAUDE_LOGIN_COMMAND,
      };
    }

    // The same gate `openSession` applies, applied where the choice is offered
    // rather than only where it is taken. Without it a binary missing a flag
    // every turn passes produces a selectable descriptor, and the failure
    // surfaces only after someone picks it and sends a message.
    const surface = await this.#readCliSurface(context);
    const refusal = this.#contractRefusal(version, surface);
    if (refusal) {
      return {
        targetId: this.targetId,
        installed: true,
        version,
        requiredVersion: MINIMUM_CLAUDE_VERSION,
        unavailableReason: 'version-unsupported',
        authState: 'unknown',
        capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
        supportedConfigurations: unsupportedConfigurations(
          CLAUDE_UNSUPPORTED_REASON_KEYS.versionTooOld
        ),
      };
    }

    const [authentication, autoModeDisabledByPolicy] = await Promise.all([
      this.#readAuthentication(context),
      this.#readAutoModePolicy(),
    ]);
    // Absent rather than empty: a surface that declared no modes has not
    // narrowed anything, and an empty set would reject every one of them.
    const acceptedModes = claudeAcceptedModes(surface);
    const availability: ClaudeModeAvailability = {
      ...(authentication.accountKind ? { accountKind: authentication.accountKind } : {}),
      autoModeDisabledByPolicy,
      // Discovery runs no turn, so no `system/init` has reported this account's
      // live permission mode. Unproven reads as "not yet on auto", which keeps
      // `default` on `manual` until a real run says otherwise — the direction
      // that cannot silently widen what runs without asking.
      effectiveDefaultIsAuto: false,
      ...(acceptedModes ? { acceptedModes } : {}),
    };

    const models = claudeModelCatalog(surface);
    return {
      targetId: this.targetId,
      installed: true,
      version,
      authState: authentication.authState,
      ...(authentication.authState === 'signed-in' ? {} : { loginCommand: CLAUDE_LOGIN_COMMAND }),
      capabilities: claudeCapabilities(models),
      supportedConfigurations: buildSupportedConfigurations(availability),
      ...(models ? { models } : {}),
      ...(authentication.account ? { account: authentication.account } : {}),
    };
  }

  /**
   * Adopts a session id without starting anything.
   *
   * A resume reference is taken at face value. The alternative is a probe run
   * per send, and a wrong guess is recoverable: a session Claude has forgotten
   * fails at the first turn with `No conversation found`, which `startTurn`
   * turns into a fresh session under `fallback` and into an error under
   * `strict`.
   */
  async openSession(input: ExternalAgentOpenSessionInput): Promise<ExternalAgentOpenedSession> {
    const { params, context } = input;
    const surface = await this.#assertSupportedContract(context);

    const [authentication, autoModeDisabledByPolicy] = await Promise.all([
      this.#readAuthentication(context),
      this.#readAutoModePolicy(),
    ]);
    // The same narrowing discovery applied, re-read rather than remembered. A
    // session opened minutes after a selector render must not pass a mode an
    // upgrade removed in between — and must not be refused by a probe that read
    // no vocabulary at all, which is why this is absent rather than empty.
    const acceptedModes = claudeAcceptedModes(surface);
    const availability: ClaudeModeAvailability = {
      ...(authentication.accountKind ? { accountKind: authentication.accountKind } : {}),
      autoModeDisabledByPolicy,
      effectiveDefaultIsAuto: false,
      ...(acceptedModes ? { acceptedModes } : {}),
    };
    this.#assertConfigurationSupported(params.configuration, availability);

    const resumed = params.resumeRef !== undefined;
    const session: ClaudeSession = {
      sessionId: params.resumeRef ?? this.#newSessionId(),
      workspacePath: params.workspacePath,
      established: resumed,
      configuration: params.configuration,
      availability,
      ...(surface?.effortLevels ? { acceptedEfforts: surface.effortLevels } : {}),
    };
    this.#sessions.set(params.sessionId, session);

    return {
      nativeSessionId: session.sessionId,
      resumed,
      effectiveConfiguration: params.configuration,
      capabilities: claudeCapabilities(claudeModelCatalog(surface)),
    };
  }

  /**
   * Spawns the turn's own process and returns its stream synchronously.
   *
   * The handle is the hub's own `clientMessageId` rather than anything the
   * vendor mints: `claude --print` names no turn, and the interface hands back a
   * stream with `nativeTurnId` already on it.
   */
  startTurn(input: ExternalAgentStartTurnInput): ExternalAgentTurnStream {
    const session = this.#requireSession(input.params.sessionId);
    const handle = input.params.clientMessageId;
    const channel = new TurnChannel<ExternalAgentEvent>();
    const reducer = new ClaudeTurnReducer({
      resumed: session.established,
      onInit: (init) => applyInit(session, init),
    });
    const active = { channel, reducer, cancelled: false, process: undefined };
    session.activeTurn = active;

    void this.#runTurn(session, active, input).catch((error: unknown) => {
      if (active.cancelled) return;
      for (const event of reducer.abort(toExternalAgentError(error, 'claude-turn'))) {
        channel.push(event);
      }
      channel.finish();
      if (session.activeTurn === active) session.activeTurn = undefined;
    });

    return { nativeTurnId: handle, [Symbol.asyncIterator]: () => channel.drain() };
  }

  async #runTurn(
    session: ClaudeSession,
    active: NonNullable<ClaudeSession['activeTurn']>,
    input: ExternalAgentStartTurnInput
  ): Promise<void> {
    const { channel, reducer } = active;
    const configuration = input.params.configuration;
    this.#assertConfigurationSupported(configuration, session.availability);

    const managed = input.context.spawn({
      argv: buildTurnArgv({
        executable: this.#requireExecutable(input.context),
        session,
        configuration,
        availability: session.availability,
      }),
    });
    active.process = managed;

    try {
      // One message, then end-of-input. A second message would run as its own
      // turn with its own result, which is a queued follow-up rather than
      // steering — see `steering: false`.
      await managed.writeLine({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: input.params.input }] },
      });
      managed.endInput();

      let sawResult = false;
      while (!reducer.finished) {
        const read = await managed.stdout.next(STREAM_IDLE_TIMEOUT_MS, input.context.signal);
        if (read.kind === 'eof') break;
        if (read.kind === 'timeout') {
          throw new ExternalAgentAdapterError(
            'claude-stream-idle',
            'Claude Code stopped producing output before the turn finished.'
          );
        }
        const record = parseClaudeStreamLine(read.line);
        if (!record) continue;
        const reduction = reducer.reduce(record);
        for (const event of reduction.events) channel.push(event);
        if (reduction.finished) sawResult = true;
      }

      // Belt and braces alongside `applyInit`: a run that somehow produced a
      // result without an init record still created the conversation, and the
      // next turn has to resume it rather than mint the same id again.
      if (sawResult) session.established = true;

      if (!sawResult && !active.cancelled) {
        const exit = await Promise.race([
          managed.exit,
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), CLAUDE_POST_RESULT_GRACE_MS).unref?.()
          ),
        ]);
        for (const event of reducer.abort({
          code: 'claude-no-result',
          message: exitMessage(exit, managed.stderrTail()),
        })) {
          channel.push(event);
        }
      }
    } catch (error) {
      // Emitted here rather than by the caller's `.catch`, because the `finally`
      // below closes the channel and `TurnChannel` drops everything pushed after
      // that. A stdout line over the reader's byte limit, an aborted turn, or an
      // EPIPE on the prompt write would otherwise end the stream with neither an
      // `error` nor a `completed` event, leaving open activity pills spinning in
      // a turn the supervisor sees simply stop.
      if (active.cancelled) return;
      for (const event of reducer.abort(toExternalAgentError(error, 'claude-turn'))) {
        channel.push(event);
      }
    } finally {
      channel.finish();
      if (session.activeTurn === active) session.activeTurn = undefined;
      // Background subagents can hold the process open after the result, so the
      // turn does not wait on the exit — but nothing is allowed to outlive the
      // turn that started it either.
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
  }

  /**
   * There is nothing to answer.
   *
   * `interactiveApprovals` is false, so the hub never renders a card for this
   * target and never routes an answer here. Reaching this method at all means a
   * caller invented an approval, which is a defect rather than a stale card.
   */
  respond(input: ExternalAgentApprovalResponseInput): Promise<void> {
    return Promise.reject(
      new ExternalAgentAdapterError(
        'claude-approvals-unsupported',
        `Claude Code does not deliver answerable approvals; "${input.requestId}" cannot be answered.`
      )
    );
  }

  /**
   * SIGTERM, and the exit code it produces is a clean cancel.
   *
   * The channel is finished before the process is asked to stop, because the
   * user pressed stop and a vendor that takes its time running `SessionEnd`
   * hooks must not hold the transcript open while it does.
   */
  async cancel(input: ExternalAgentCancelInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    const active = session?.activeTurn;
    if (!session || !active) return;
    active.cancelled = true;
    session.activeTurn = undefined;
    active.channel.finish();
    await active.process?.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
  }

  async close(input: ExternalAgentCloseInput): Promise<void> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return;
    this.#sessions.delete(input.sessionId);
    const active = session.activeTurn;
    if (!active) return;
    active.cancelled = true;
    session.activeTurn = undefined;
    active.channel.finish();
    await active.process?.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
  }

  #requireSession(sessionId: string): ClaudeSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new ExternalAgentAdapterError(
        'claude-session-missing',
        `Claude Code session "${sessionId}" is not open.`
      );
    }
    return session;
  }

  #requireExecutable(context: ExternalAgentAdapterContext): string {
    const executable = context.executablePath;
    if (!executable) {
      throw new ExternalAgentAdapterError(
        'claude-not-installed',
        'The Claude Code CLI was not found.'
      );
    }
    return executable;
  }

  /**
   * Refuses a pair this account cannot actually run, before a process starts.
   *
   * The descriptor already reported it unsupported, but discovery is cached and
   * a stored chat configuration outlives it. Passing `--permission-mode auto` to
   * a CLI whose managed settings reject it produces a startup failure
   * indistinguishable from every other startup failure.
   */
  #assertConfigurationSupported(
    configuration: ExternalAgentConfiguration,
    availability: ClaudeModeAvailability
  ): void {
    const mode = claudePermissionMode(configuration.level, configuration.routing, availability);
    if (mode && claudeModeAccepted(mode, availability)) return;
    throw new ExternalAgentAdapterError(
      'claude-configuration-unsupported',
      `Claude Code cannot run "${configuration.level}" with "${configuration.routing}" on this account.`
    );
  }

  /**
   * Why this build cannot be driven, or `undefined` when it can.
   *
   * The flag surface decides, and the version only steps in when the surface
   * could not be read. That ordering is the point: the pin exists because
   * `--forward-subagent-text` landed in a particular release, so asking whether
   * the flag is *there* answers the real question, and a below-pin build that
   * has everything this adapter passes stays usable instead of being greyed out
   * by arithmetic.
   */
  #contractRefusal(version: string, surface: ClaudeCliSurface | undefined): string | undefined {
    if (surface) {
      const missing = missingClaudeCliFlags(surface);
      return missing.length > 0
        ? `Claude Code ${version} does not offer ${missing.join(', ')}, which every turn passes. Upgrade to ${MINIMUM_CLAUDE_VERSION} or later.`
        : undefined;
    }
    // No usable surface, so the pin is all that is left to go on.
    return isClaudeVersionSupported(parseClaudeVersion(version), MINIMUM_CLAUDE_VERSION_PARSED)
      ? undefined
      : `Claude Code ${version} predates the ${MINIMUM_CLAUDE_VERSION} this runtime drives, and its flag surface could not be read. Upgrade the Claude Code CLI.`;
  }

  /** The `openSession` half of the same gate, throwing where discovery greys out. */
  async #assertSupportedContract(
    context: ExternalAgentAdapterContext
  ): Promise<ClaudeCliSurface | undefined> {
    const version = await this.#readVersion(context);
    if (!version) {
      throw new ExternalAgentAdapterError(
        'claude-version-unsupported',
        'The Claude Code CLI did not report a version this runtime could read.'
      );
    }
    const surface = await this.#readCliSurface(context);
    const refusal = this.#contractRefusal(version, surface);
    if (refusal) throw new ExternalAgentAdapterError('claude-version-unsupported', refusal);
    return surface;
  }

  /**
   * `claude --help`, parsed into the flags and modes this adapter depends on.
   *
   * `undefined` when the probe produced nothing recognizable, which callers
   * read as "not established" rather than as "the binary has no options" — a
   * spawn that failed must not look like a vendor that removed everything.
   */
  async #readCliSurface(
    context: ExternalAgentAdapterContext
  ): Promise<ClaudeCliSurface | undefined> {
    const help = await this.#readAllOutput(context, ['--help']);
    if (help === undefined) return undefined;
    const surface = parseClaudeCliSurface(help);
    return isUsableClaudeCliSurface(surface) ? surface : undefined;
  }

  async #readVersion(context: ExternalAgentAdapterContext): Promise<string | undefined> {
    const line = await this.#readFirstLine(context, ['--version']);
    return line && line.length > 0 ? line : undefined;
  }

  /**
   * `claude auth status`, which is structured and authoritative.
   *
   * The scanner's file probe stays as the fallback rather than the primary:
   * Claude may keep credentials in the system keychain, so a missing
   * `.credentials.json` is not a signed-out verdict. A failed invocation here
   * lands on `unknown` for the same reason.
   */
  async #readAuthentication(context: ExternalAgentAdapterContext): Promise<ClaudeAuthentication> {
    const stdout = await this.#readAllOutput(context, ['auth', 'status']);
    return stdout === undefined ? CLAUDE_AUTH_UNKNOWN : parseClaudeAuthStatus(stdout);
  }

  /**
   * `disableAutoMode` from managed settings, read directly.
   *
   * Never inferred from a failed probe run: the CLI rejects
   * `--permission-mode auto` *at startup* when policy forbids it, and a startup
   * rejection is indistinguishable from any other startup failure. Guessing
   * wrong means passing a mode an administrator deliberately turned off.
   */
  async #readAutoModePolicy(): Promise<boolean> {
    try {
      return readAutoModeDisabled(await this.#readManagedSettings());
    } catch {
      // No managed settings file is the common case, and an unreadable one is
      // not a policy statement. Either way `auto` stays decided by the account.
      return false;
    }
  }

  async #readFirstLine(
    context: ExternalAgentAdapterContext,
    args: readonly string[]
  ): Promise<string | undefined> {
    const executable = context.executablePath;
    if (!executable) return undefined;
    const managed = context.spawn({ argv: [executable, ...args] as [string, ...string[]] });
    try {
      const read = await managed.stdout.next(PROBE_TIMEOUT_MS, context.signal);
      return read.kind === 'line' ? read.line.trim() : undefined;
    } catch {
      return undefined;
    } finally {
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
  }

  /** Every line a short-lived probe wrote, joined. Bounded by the reader's own caps. */
  async #readAllOutput(
    context: ExternalAgentAdapterContext,
    args: readonly string[]
  ): Promise<string | undefined> {
    const executable = context.executablePath;
    if (!executable) return undefined;
    const managed = context.spawn({ argv: [executable, ...args] as [string, ...string[]] });
    const lines: string[] = [];
    try {
      while (true) {
        const read = await managed.stdout.next(PROBE_TIMEOUT_MS, context.signal);
        if (read.kind !== 'line') break;
        lines.push(read.line);
      }
      return lines.length > 0 ? lines.join('\n') : undefined;
    } catch {
      return undefined;
    } finally {
      await managed.terminate({ graceMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
    }
  }
}

/** Reads the administrator-managed settings document, if this machine has one. */
async function readManagedSettingsFile(): Promise<unknown> {
  const raw = await readFile(claudeManagedSettingsPath(), 'utf8');
  return JSON.parse(raw);
}

/**
 * Folds a run's `system/init` back into the session.
 *
 * The session id is the one thing here discovery could not know, because it
 * takes a live process to learn it — and the record proves the conversation now
 * exists on disk, which is what makes the *next* turn a `--resume` rather than
 * another attempt to mint an id the CLI has already taken.
 *
 * `init.permissionMode` is deliberately **not** folded back into
 * `availability.effectiveDefaultIsAuto`. Every run is launched with an explicit
 * `--permission-mode`, so the record echoes the mode MangoStudio chose rather
 * than the account's own default — it can never establish the 2026-08-14 flip,
 * and reading it as if it could is actively unsafe: one turn at
 * `default` + `auto-review` passes `auto`, sees `auto` echoed back, and would
 * then silently resolve the plain `default` level to `auto` for the rest of the
 * session. A user who asked to be asked would stop being asked.
 */
function applyInit(session: ClaudeSession, init: ClaudeRunInit): void {
  if (init.sessionId && init.sessionId.length > 0) {
    session.sessionId = init.sessionId;
    session.established = true;
  }
  if (init.model && init.model.length > 0) {
    session.configuration = { ...session.configuration, model: init.model };
  }
}

/**
 * Model identifiers, as a shape rather than as a promise.
 *
 * `configuration.model` is caller-owned: Claude advertises no catalog, so
 * `pickModel` has nothing to vet a requested value against and passes it
 * straight through. An argv array stops *shell* injection, not **argument**
 * injection — a value beginning with `-` is read by the CLI's parser as a new
 * flag rather than as `--model`'s value, which is how a stored chat
 * configuration could put `--dangerously-skip-permissions` on the command line.
 *
 * An unrecognized value is dropped rather than refused: the vendor's own
 * default is a working turn, and failing a send over a model string is a worse
 * answer than ignoring one.
 */
const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export function safeClaudeModel(model: string | undefined): string | undefined {
  return model !== undefined && model.length <= 128 && CLAUDE_MODEL_PATTERN.test(model)
    ? model
    : undefined;
}

/** The turn's argv. Everything that is not a flag comes from server-owned state. */
export function buildTurnArgv(input: {
  readonly executable: string;
  readonly session: Pick<ClaudeSession, 'sessionId' | 'established' | 'acceptedEfforts'>;
  readonly configuration: ExternalAgentConfiguration;
  readonly availability: ClaudeModeAvailability;
}): [string, ...string[]] {
  const mode = claudePermissionMode(
    input.configuration.level,
    input.configuration.routing,
    input.availability
  );
  /* c8 ignore next -- callers assert support before reaching here. */
  if (!mode) throw new Error('No Claude permission mode for this configuration.');

  return [
    input.executable,
    '--print',
    // stdin, so the prompt never appears in a process listing.
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Both required for token-level deltas; without them the stream arrives in
    // whole messages and nothing renders until each block is complete.
    '--verbose',
    '--include-partial-messages',
    // Subagent output, tagged with the tool call that spawned it. Needs 2.1.211,
    // which is why that is the pinned minimum rather than 2.1.200.
    '--forward-subagent-text',
    '--permission-mode',
    mode,
    // The session id is the whole continuity mechanism: minted on the first run,
    // resumed afterwards. The same `cwd` is passed either way, because below
    // 2.1.223 `--resume` only looks inside the directory the session was made in.
    ...(input.session.established
      ? ['--resume', input.session.sessionId]
      : ['--session-id', input.session.sessionId]),
    ...modelArguments(input.configuration.model),
    ...effortArguments(input.configuration.effort, input.session.acceptedEfforts),
  ];
}

function modelArguments(model: string | undefined): string[] {
  const safe = safeClaudeModel(model);
  return safe ? ['--model', safe] : [];
}

/**
 * `--effort`, passed only for a level this build itself printed.
 *
 * Membership in the parsed set is the whole guard, and it is stricter than
 * `safeClaudeModel`'s pattern because it can be: the vendor publishes the
 * complete list, so there is no need to accept a shape and hope. A build that
 * declared no levels — every build before 2.1.259 — therefore never sees the
 * flag, which is what keeps a stored per-chat effort from breaking a downgrade.
 */
function effortArguments(
  effort: string | undefined,
  accepted: ReadonlySet<string> | undefined
): string[] {
  return claudeEffortAccepted(effort, accepted) ? ['--effort', effort as string] : [];
}

/** What to say about a process that ended without a `result` record. */
function exitMessage(
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined,
  stderrTail: string
): string {
  const detail = stderrTail.trim().slice(-512);
  if (exit?.code === CLAUDE_SIGTERM_EXIT_CODE || exit?.signal === 'SIGTERM') {
    return 'Claude Code was stopped before the turn finished.';
  }
  const ended = exit ? `exit code ${exit.code ?? exit.signal ?? 'unknown'}` : 'no exit code';
  return detail.length > 0
    ? `Claude Code ended without a result (${ended}): ${detail}`
    : `Claude Code ended without a result (${ended}).`;
}
