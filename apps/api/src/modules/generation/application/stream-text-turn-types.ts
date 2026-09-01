import type {
  ContinuationReasonCode,
  McpMediaPart,
  ProviderType,
  QuestionPart,
  ReasoningEffort,
  TodoPart,
} from '@mangostudio/shared';
import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type { ImageGenerationErrorCode, ToolIntent } from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import type { TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type {
  ContextSeverity,
  ContinuationDisplayMode,
} from '../../../services/providers/core/context-policy';
import type { ResolvedModel } from './resolve-model';
import type { ToolStreamEvent } from './standard-tool-execution';

export interface StreamTextTurnInput {
  chatId: string;
  userId: string;
  prompt: string;
  attachmentIds?: string[];
  model?: string;
  systemPrompt?: string;
  promptSettings?: PromptSettings;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxToolIterations?: number;
  contextSettings?: ContextSettings;
  toolIntent?: ToolIntent;
  agentId?: AgentId;
  resolvedAgentProfile?: AgentProfile;
  signal?: AbortSignal;
  resolvedModel?: ResolvedModel;
  preparedTurn?: {
    readonly userMessageId: string;
    readonly assistantMessageId: string;
    readonly checkpoint: TurnCheckpointPart;
  };
  onTurnPrepared?: (assistantMessageId: string) => void;
}

export type StreamEvent =
  | { type: 'user_message_id'; messageId: string }
  | { type: 'assistant_message_id'; messageId: string }
  | { type: 'thinking_start' }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call_started'; callId: string; name: string }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError: boolean }
  | ToolStreamEvent
  | { type: 'image_generation_started'; imageId: string; toolCallId: string; prompt: string }
  | {
      type: 'image_generation_completed';
      imageId: string;
      toolCallId: string;
      prompt: string;
      imageUrl: string;
      modelName?: string;
      generationTime?: string;
    }
  | {
      type: 'image_generation_failed';
      imageId: string;
      toolCallId: string;
      prompt: string;
      error: string;
      errorCode?: ImageGenerationErrorCode;
      modelName?: string;
      generationTime?: string;
    }
  | { type: 'mcp_media'; part: McpMediaPart }
  | { type: 'question'; part: QuestionPart }
  | { type: 'todo_update'; part: TodoPart }
  | { type: 'fallback_notice'; from: string; to: string; reason: string }
  | {
      type: 'continuation_transition';
      provider: ProviderType;
      modelName: string;
      fromProvider?: ProviderType;
      fromMode: string;
      toMode: string;
      reasonCode: ContinuationReasonCode;
      detail?: string;
    }
  | {
      type: 'context_info';
      estimatedInputTokens: number;
      contextLimit: number;
      estimatedUsageRatio: number;
      mode: ContinuationDisplayMode;
      severity: ContextSeverity;
    }
  | { type: 'done'; messageId: string; generationTime: string }
  | { type: 'error'; error: string; code?: string };
