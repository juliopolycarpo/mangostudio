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

/** Runtime-owned resources an adapter may use without reaching into hub state. */
export interface ExternalAgentAdapterContext {
  readonly signal: AbortSignal;
  readonly executablePath?: string;
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
  spawn(options: SpawnExternalAgentProcessOptions): ExternalAgentManagedProcess;
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
