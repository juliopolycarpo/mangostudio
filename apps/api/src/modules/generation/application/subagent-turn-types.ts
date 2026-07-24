import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import type { SubagentTracePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { WorkdirPolicy } from '../../../services/tools/types';

export const SUBAGENT_TIMEOUT_CODE = 'TIMEOUT';
export const SUBAGENT_ABORT_CODE = 'ABORTED';
export const SUBAGENT_FAILED_CODE = 'FAILED';
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
  /** Parent turn's assistant message, so subagent file mutations join its checkpoint. */
  readonly assistantMessageId?: string;
  readonly workdir?: string;
  readonly workdirPolicy?: WorkdirPolicy;
  readonly parentAgentProfile: AgentProfile;
  readonly parentModelName: string;
  readonly parentMode: 'chat' | 'agent';
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
