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
 * but never reads OAuth credentials or the system keychain and therefore
 * requires `ANTHROPIC_API_KEY`. Determinism and subscription auth are mutually
 * exclusive today and v1 takes subscription auth — so the runtime host's own
 * `~/.claude` is inherited, hooks, plugins, MCP servers and all. That is a
 * limit, not a feature, and it is disclosed rather than papered over.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ExternalAgentCapabilities,
  ExternalAgentConfiguration,
  ExternalAgentEvent,
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
  buildSupportedConfigurations,
  CLAUDE_UNSUPPORTED_REASON_KEYS,
  type ClaudeModeAvailability,
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
 * - `modelCatalog` — `--model` accepts a value; that is not a catalog. No
 *   structured listing has been captured, so the selector hides the picker
 *   rather than offering a list MangoStudio invented.
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

interface ClaudeSession {
  /** The vendor session id. Stable across turns; `--resume` echoes it back. */
  sessionId: string;
  readonly workspacePath: string;
  /** False until a turn has actually created the session on disk. */
  established: boolean;
  configuration: ExternalAgentConfiguration;
  availability: ClaudeModeAvailability;
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
    // rather than only where it is taken. Without it a too-old binary whose
    // `auth status` still answers produces a selectable descriptor, and the
    // version failure surfaces only after someone picks it and sends a message.
    if (!isClaudeVersionSupported(parseClaudeVersion(version), MINIMUM_CLAUDE_VERSION_PARSED)) {
      return {
        targetId: this.targetId,
        installed: true,
        version,
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
    const availability: ClaudeModeAvailability = {
      ...(authentication.accountKind ? { accountKind: authentication.accountKind } : {}),
      autoModeDisabledByPolicy,
      // Discovery runs no turn, so no `system/init` has reported this account's
      // live permission mode. Unproven reads as "not yet on auto", which keeps
      // `default` on `manual` until a real run says otherwise — the direction
      // that cannot silently widen what runs without asking.
      effectiveDefaultIsAuto: false,
    };

    return {
      targetId: this.targetId,
      installed: true,
      version,
      authState: authentication.authState,
      ...(authentication.authState === 'signed-in' ? {} : { loginCommand: CLAUDE_LOGIN_COMMAND }),
      capabilities: CLAUDE_CAPABILITIES,
      supportedConfigurations: buildSupportedConfigurations(availability),
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
    await this.#assertSupportedVersion(context);

    const [authentication, autoModeDisabledByPolicy] = await Promise.all([
      this.#readAuthentication(context),
      this.#readAutoModePolicy(),
    ]);
    const availability: ClaudeModeAvailability = {
      ...(authentication.accountKind ? { accountKind: authentication.accountKind } : {}),
      autoModeDisabledByPolicy,
      effectiveDefaultIsAuto: false,
    };
    this.#assertConfigurationSupported(params.configuration, availability);

    const resumed = params.resumeRef !== undefined;
    const session: ClaudeSession = {
      sessionId: params.resumeRef ?? this.#newSessionId(),
      workspacePath: params.workspacePath,
      established: resumed,
      configuration: params.configuration,
      availability,
    };
    this.#sessions.set(params.sessionId, session);

    return {
      nativeSessionId: session.sessionId,
      resumed,
      effectiveConfiguration: params.configuration,
      capabilities: CLAUDE_CAPABILITIES,
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

      // A session only becomes resumable once a run has actually created it.
      // Marking it earlier would make the next turn pass `--resume` for a
      // conversation that does not exist.
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
    if (claudePermissionMode(configuration.level, configuration.routing, availability)) return;
    throw new ExternalAgentAdapterError(
      'claude-configuration-unsupported',
      `Claude Code cannot run "${configuration.level}" with "${configuration.routing}" on this account.`
    );
  }

  async #assertSupportedVersion(context: ExternalAgentAdapterContext): Promise<void> {
    const raw = await this.#readVersion(context);
    const observed = raw ? parseClaudeVersion(raw) : undefined;
    if (isClaudeVersionSupported(observed, MINIMUM_CLAUDE_VERSION_PARSED)) return;
    throw new ExternalAgentAdapterError(
      'claude-version-unsupported',
      raw
        ? `Claude Code ${raw} predates the ${MINIMUM_CLAUDE_VERSION} this runtime drives. Upgrade the Claude Code CLI.`
        : 'The Claude Code CLI did not report a version this runtime could read.'
    );
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
 * Two things are learned here that discovery could not know, because both need
 * a live process: the session id the vendor actually used, and the permission
 * mode this account resolves its default to. The second is what makes
 * MangoStudio's `default` level follow the account through the 2026-08-14 flip
 * instead of pinning a mode the user sees nowhere else.
 */
function applyInit(session: ClaudeSession, init: ClaudeRunInit): void {
  if (init.sessionId && init.sessionId.length > 0) session.sessionId = init.sessionId;
  if (init.permissionMode !== undefined) {
    session.availability = {
      ...session.availability,
      effectiveDefaultIsAuto: init.permissionMode === 'auto',
    };
  }
  if (init.model && init.model.length > 0) {
    session.configuration = { ...session.configuration, model: init.model };
  }
}

/** The turn's argv. Everything that is not a flag comes from server-owned state. */
export function buildTurnArgv(input: {
  readonly executable: string;
  readonly session: Pick<ClaudeSession, 'sessionId' | 'established'>;
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
    ...(input.configuration.model ? ['--model', input.configuration.model] : []),
  ];
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
