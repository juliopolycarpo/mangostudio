import type {
  ExternalAgentCancelParams,
  ExternalAgentEvent,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRespondParams,
  ExternalAgentRuntimeDescriptor,
  ExternalAgentTargetId,
  ExternalAgentTurnParams,
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
  readonly nativeSessionId: string;
  readonly nativeTurnId: string;
  readonly input: string;
}

export interface ExternalAgentSteerResult {
  readonly accepted: boolean;
}

export interface ExternalAgentListSessionsInput {
  readonly cursor?: string;
  /**
   * Which open session's connection answers the listing.
   *
   * An adapter that keeps one vendor process per session — Cursor does, because
   * each session carries its own cwd and environment — has no single connection
   * to ask. Optional because an adapter with one shared process has nothing to
   * choose between.
   */
  readonly sessionId?: string;
}

export interface ExternalAgentNativeSessionPage {
  readonly sessionIds: readonly string[];
  readonly nextCursor?: string;
}

export interface ExternalAgentStartReviewInput {
  readonly nativeSessionId: string;
  readonly context: ExternalAgentAdapterContext;
}

export interface ExternalAgentRefreshUsageInput {
  readonly context: ExternalAgentAdapterContext;
}

export interface ExternalAgentAccountUsage {
  readonly summary: string;
}

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
  steer?(input: ExternalAgentSteerInput): Promise<ExternalAgentSteerResult>;
  listSessions?(input: ExternalAgentListSessionsInput): Promise<ExternalAgentNativeSessionPage>;
  startReview?(input: ExternalAgentStartReviewInput): ExternalAgentTurnStream;
  refreshAccountUsage?(input: ExternalAgentRefreshUsageInput): Promise<ExternalAgentAccountUsage>;
}
