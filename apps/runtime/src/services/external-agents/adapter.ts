import type {
  ExternalAccountLimits,
  ExternalAgentCancelParams,
  ExternalAgentEvent,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRespondParams,
  ExternalAgentRuntimeDescriptor,
  ExternalAgentTargetId,
  ExternalAgentTurnParams,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import type { ExternalAgentManagedProcess, SpawnExternalAgentProcessOptions } from './process';

/**
 * What an adapter may set when launching a process.
 *
 * The working directory and the environment are absent on purpose. Both are
 * supervisor-owned — the cwd is the workspace it canonicalized and authorized,
 * and the environment is the positive allowlist that keeps a connector secret
 * out of a vendor child — and both were already overwritten before the spawn
 * happened. Omitting them from the type means an adapter cannot write a value
 * that silently does nothing, and cannot appear to inject one that matters.
 */
export type ExternalAgentAdapterSpawnOptions = Omit<
  SpawnExternalAgentProcessOptions,
  'cwd' | 'envSource' | 'vendorEnvironmentKeys'
>;

/** Runtime-owned resources an adapter may use without reaching into hub state. */
export interface ExternalAgentAdapterContext {
  readonly signal: AbortSignal;
  readonly executablePath?: string;
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
  spawn(options: ExternalAgentAdapterSpawnOptions): ExternalAgentManagedProcess;
}

export interface ExternalAgentOpenedSession extends ExternalAgentOpenResult {}

/**
 * A turn is still an AsyncIterable as far as the supervisor is concerned, but
 * carries the vendor turn handle returned by the request that started it.
 */
export interface ExternalAgentTurnStream extends AsyncIterable<ExternalAgentEvent> {
  readonly nativeTurnId: string;
}

export interface ExternalAgentOpenSessionInput {
  readonly params: ExternalAgentOpenParams;
  readonly context: ExternalAgentAdapterContext;
}

export interface ExternalAgentStartTurnInput {
  readonly nativeSessionId: string;
  readonly params: ExternalAgentTurnParams;
  readonly context: ExternalAgentAdapterContext;
}

export interface ExternalAgentApprovalResponseInput extends ExternalAgentRespondParams {
  readonly nativeSessionId: string;
}

export interface ExternalAgentCancelInput extends ExternalAgentCancelParams {
  readonly nativeSessionId: string;
  readonly reason: 'requested' | 'consent-revoked' | 'timeout' | 'shutdown';
}

export interface ExternalAgentCloseInput {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly reason: 'requested' | 'consent-revoked' | 'shutdown';
}

export interface ExternalAgentSteerInput {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  /** The hub's own turn handle — see {@link ExternalAgentTurnStream.nativeTurnId}. */
  readonly nativeTurnId: string;
  readonly clientMessageId: string;
  readonly input: string;
}

/**
 * Named apart from the shared `ExternalAgentSteerResult` wire type, which this
 * would otherwise collide with under `export type *`. `not-supported` and
 * `session-lost` are never produced here: the supervisor refuses those before
 * an adapter is called at all, because neither is a fact about the vendor's
 * turn. Only the two reasons a vendor can actually decide.
 */
export type ExternalAgentSteerOutcome =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reasonCode: 'turn-already-completed' | 'turn-not-steerable';
    };

export interface ExternalAgentListSessionsInput {
  /**
   * Everything a probe needs when no session is open.
   *
   * A listing is asked for *before* a chat exists — that is the whole point of
   * the picker — so an adapter that has no live connection opens a short-lived
   * one, exactly as discovery and the account-usage refresh already do.
   */
  readonly context: ExternalAgentAdapterContext;
  readonly cursor?: string;
  readonly limit?: number;
  /** Exact-match workspace filter, canonical as the target machine spells it. */
  readonly workspacePath?: string;
  /**
   * Which open session's connection answers the listing.
   *
   * An adapter that keeps one vendor process per session — Cursor does, because
   * each session carries its own cwd and environment — has no single connection
   * to ask. Optional because an adapter with one shared process has nothing to
   * choose between, and because a picker rendered before any chat exists has no
   * session to name.
   */
  readonly sessionId?: string;
}

export interface ExternalAgentNativeSessionPage {
  readonly sessions: readonly ExternalNativeSession[];
  readonly nextCursor?: string;
}

export interface ExternalAgentStartReviewInput {
  readonly nativeSessionId: string;
  readonly context: ExternalAgentAdapterContext;
}

export interface ExternalAgentRefreshUsageInput {
  readonly context: ExternalAgentAdapterContext;
  /** When set, refresh against this live session rather than opening a probe. */
  readonly sessionId?: string;
}

/** Account-level plan quota from a vendor that supports `accountUsage`. */
export type ExternalAgentAccountUsage = {
  readonly limits: ExternalAccountLimits;
};

/** Vendor-neutral lifecycle. Protocol codecs and process policy remain inside adapters. */
export interface ExternalAgentAdapter {
  readonly targetId: ExternalAgentTargetId;
  readonly vendorEnvironmentKeys?: readonly string[];
  discover(context: ExternalAgentAdapterContext): Promise<ExternalAgentRuntimeDescriptor>;
  openSession(input: ExternalAgentOpenSessionInput): Promise<ExternalAgentOpenedSession>;
  startTurn(input: ExternalAgentStartTurnInput): ExternalAgentTurnStream;
  respond(input: ExternalAgentApprovalResponseInput): Promise<void>;
  cancel(input: ExternalAgentCancelInput): Promise<void>;
  close(input: ExternalAgentCloseInput): Promise<void>;
  steer?(input: ExternalAgentSteerInput): Promise<ExternalAgentSteerOutcome>;
  listSessions?(input: ExternalAgentListSessionsInput): Promise<ExternalAgentNativeSessionPage>;
  startReview?(input: ExternalAgentStartReviewInput): ExternalAgentTurnStream;
  refreshAccountUsage?(input: ExternalAgentRefreshUsageInput): Promise<ExternalAgentAccountUsage>;
}
