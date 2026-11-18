import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { SubagentTracePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import type { WorkdirPolicy } from '../../../services/tools/types';

export const SUBAGENT_TIMEOUT_CODE = 'TIMEOUT';
export const SUBAGENT_ABORT_CODE = 'ABORTED';
export const SUBAGENT_FAILED_CODE = 'FAILED';
export const SUBAGENT_MODEL_UNAVAILABLE_CODE = 'MODEL_UNAVAILABLE';
export const SUBAGENT_EMPTY_TEXT_FALLBACK = 'Subagent completed without a text response.';
export const SUBAGENT_SUMMARIZE_PROMPT =
  'Final summary required. Respond now in plain text only — do not call any tools. Summarise your findings: key points, relevant file paths or commands, and recommended next steps if any.';

export type SubagentStatus = 'completed' | 'failed' | 'aborted' | 'timeout';

export interface DelegateToSubagentRequest {
  readonly agentId: AgentId;
  readonly task: string;
  readonly context?: string;
  readonly expectedOutput?: string;
  readonly maxTurns?: number;
}

export type SubagentProgressEvent =
  | { type: 'started'; agentId: AgentId; agentName: string; task: string }
  | { type: 'text'; agentId: AgentId; text: string }
  | { type: 'tool_call_started'; agentId: AgentId; toolCallId: string; name: string }
  | {
      type: 'completed';
      agentId: AgentId;
      agentName: string;
      summary: string;
      toolCallCount: number;
    }
  | { type: 'failed'; agentId: string; agentName?: string; error: string };

export interface SubagentRunResult {
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly status: SubagentStatus;
  readonly summary: string;
  readonly messages: ReadonlyArray<{ role: 'assistant' | 'system'; text: string }>;
  readonly toolCallCount: number;
  readonly tools: ReadonlyArray<{ callId: string; name: string; isError?: boolean }>;
  readonly modelName?: string;
  readonly durationMs: number;
  readonly error?: { code: string; message: string };
  readonly trace: SubagentTracePart;
}

export interface SubagentRuntimeInput {
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly chatId: string;
  readonly environmentId: string;
  /** Parent turn's assistant message, so subagent file mutations join its checkpoint. */
  readonly assistantMessageId?: string;
  readonly workdir?: string;
  readonly workdirPolicy?: WorkdirPolicy;
  readonly parentAgentProfile: AgentProfile;
  readonly parentModelName: string;
  readonly settings: MultiAgentSettings;
  readonly request: DelegateToSubagentRequest;
  readonly depth: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: SubagentProgressEvent) => void;
}

export class SubagentDelegationError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'SubagentDelegationError';
  }
}

/**
 * The model an agent profile pins is not served by any connector, typically
 * because its API key was revoked or its connector removed after the pin was
 * saved. Raised before the subagent runs anything, so nothing needs replaying.
 *
 * It names the agent, the model and the recovery, and is deliberately not
 * answered by running on the parent's model: that would move the task to a
 * different provider and cost model the user never chose for this agent.
 */
export class SubagentModelUnavailableError extends SubagentDelegationError {
  constructor(
    readonly agentId: AgentId,
    readonly modelId: string
  ) {
    super(
      `Agent "${agentId}" is pinned to model "${modelId}", but no configured connector serves it (its API key may have been revoked or the connector removed). Restore the connector in Settings, or pick an available model for this agent.`,
      SUBAGENT_MODEL_UNAVAILABLE_CODE
    );
    this.name = 'SubagentModelUnavailableError';
  }
}

/**
 * The provider rejected the key of the connector serving the agent's model
 * (HTTP 401 or 403), typically because the key was revoked or expired.
 *
 * Distinct from {@link SubagentModelUnavailableError}: the connector exists and
 * routes, so the fix is its key, not its presence. The message names the agent,
 * the model and the connector to fix, and carries the shared
 * `PROVIDER_CREDENTIAL_REJECTED` code so the parent can tell this from any
 * other failed delegation. The provider's own text is left out on purpose, as
 * it can echo part of the key.
 */
export class SubagentCredentialRejectedError extends SubagentDelegationError {
  constructor(
    readonly agentId: AgentId,
    readonly modelId: string,
    readonly provider: string,
    readonly httpStatus: number,
    readonly connectorNames: readonly string[]
  ) {
    super(
      `Agent "${agentId}" could not run on model "${modelId}": the ${provider} provider rejected the API key of ${describeConnectors(connectorNames)} (HTTP ${httpStatus}). It may have been revoked or expired, or lack access to this model. Update the key in Settings, or pick another model for this agent.`,
      ERROR_CODES.PROVIDER_CREDENTIAL_REJECTED
    );
    this.name = 'SubagentCredentialRejectedError';
  }
}

function describeConnectors(names: readonly string[]): string {
  if (names.length === 0) return 'its connector';
  const quoted = names.map((name) => `"${name}"`).join(', ');
  return names.length === 1 ? `connector ${quoted}` : `connectors ${quoted}`;
}
