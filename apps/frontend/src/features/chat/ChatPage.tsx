import type { Message, ReasoningEffort } from '@mangostudio/shared';
import type { AgentExecutionMode, AgentProfile } from '@mangostudio/shared/agents';
import type { ContextSettings } from '@mangostudio/shared/chat';
import { isTurnCheckpointPart, type TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { WorkspaceSettings } from '@mangostudio/shared/workspaces';
import { useMemo } from 'react';
import type { ContextInfo, FallbackNotice } from '@/features/generation/types';
import { WorkdirPickerDialog } from '@/features/workspace/WorkdirPickerDialog';
import { authClient } from '@/lib/auth-client';
import { ChatPageContent } from './components/ChatPageContent';
import { ChatContextDecisionNotice, ChatFallbackNotice } from './components/ChatPageNotices';
import { InputBar } from './components/InputBar';
import { InterruptedTurnNotice } from './components/InterruptedTurnNotice';
import { PinnedTodoPanel } from './components/PinnedTodoPanel';
import { useChatContextControls, useChatPageMessages } from './hooks/use-chat-page-state';

interface ChatPageProps {
  chatId: string | null;
  onSubmit: (prompt: string, attachmentIds?: string[]) => void;
  disabled: boolean;
  isGenerating: boolean;
  onStop: () => void;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  onThinkingToggle: (enabled: boolean) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  reasoningVisible: boolean;
  contextInfo?: ContextInfo | null;
  fallbackNotice?: FallbackNotice | null;
  seedContextInfo?: (chatId: string, info: ContextInfo) => void;
  contextSettings: ContextSettings;
  isContextActionPending: boolean;
  onCompactCurrentChat: () => Promise<void>;
  onStartSummarizedChat: () => Promise<void>;
  imageToolIntent: boolean;
  onImageToolIntentChange: (active: boolean) => void;
  activeModel?: string | null;
  agentExecutionMode?: AgentExecutionMode;
  selectedAgentId?: string;
  agents?: ReadonlyArray<AgentProfile>;
  isAgentListLoading?: boolean;
  onAgentExecutionModeChange?: (mode: AgentExecutionMode) => void;
  onSelectedAgentIdChange?: (agentId: string) => void;
  workdir?: string | null;
  workspaceSettings?: WorkspaceSettings;
  isWorkdirPickerOpen?: boolean;
  onOpenWorkdirPicker?: () => void;
  onCloseWorkdirPicker?: () => void;
  onSelectWorkdir?: (path: string) => void | Promise<void>;
  onResumeInterruptedTurn: (messageId: string, retryCallIds: string[]) => Promise<void>;
  onDismissInterruptedTurn: (messageId: string) => Promise<void>;
}

interface InterruptedTurn {
  readonly messageId: string;
  readonly checkpoint: TurnCheckpointPart;
}

function findLatestInterruptedTurn(messages: readonly Message[]): InterruptedTurn | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message.role !== 'ai') continue;
    // This runs on every message change, so every streaming delta re-scans the
    // whole chat. Narrow on the discriminator first and pay for full schema
    // validation only on a part that already claims to be an interrupted turn.
    const candidate = message.parts?.find(
      (part) => part.type === 'turn_checkpoint' && part.status === 'interrupted'
    );
    if (candidate && isTurnCheckpointPart(candidate)) {
      return { messageId: message.id, checkpoint: candidate };
    }
  }
  return null;
}

export function ChatPage({
  chatId,
  onSubmit,
  disabled,
  isGenerating,
  onStop,
  thinkingEnabled,
  reasoningEffort,
  onThinkingToggle,
  onReasoningEffortChange,
  reasoningVisible,
  contextInfo,
  fallbackNotice,
  seedContextInfo,
  contextSettings,
  isContextActionPending,
  onCompactCurrentChat,
  onStartSummarizedChat,
  imageToolIntent,
  onImageToolIntentChange,
  activeModel = null,
  agentExecutionMode = 'chat',
  selectedAgentId = 'default',
  agents = [],
  isAgentListLoading = false,
  onAgentExecutionModeChange,
  onSelectedAgentIdChange,
  workdir = null,
  workspaceSettings,
  isWorkdirPickerOpen = false,
  onOpenWorkdirPicker,
  onCloseWorkdirPicker,
  onSelectWorkdir,
  onResumeInterruptedTurn,
  onDismissInterruptedTurn,
}: ChatPageProps) {
  const { messages, status } = useChatPageMessages({ chatId, seedContextInfo });
  const interruptedTurn = useMemo(() => findLatestInterruptedTurn(messages), [messages]);
  const { data: session } = authClient.useSession();
  const userName = session?.user?.name?.split(' ')[0] ?? '';
  const contextControls = useChatContextControls({
    chatId,
    contextInfo,
    contextSettings,
    isContextActionPending,
    onCompactCurrentChat,
    onStartSummarizedChat,
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <ChatPageContent
        chatId={chatId}
        messages={messages}
        status={status}
        userName={userName}
        onSubmit={onSubmit}
        onQuestionSubmit={
          isGenerating || disabled || contextControls.requiresDecision || isContextActionPending
            ? undefined
            : onSubmit
        }
      />
      {fallbackNotice && <ChatFallbackNotice notice={fallbackNotice} />}
      {contextControls.requiresDecision && (
        <ChatContextDecisionNotice
          warningMessage={contextControls.warningMessage}
          isPending={isContextActionPending}
          onCompact={() => void contextControls.handleCompactClick()}
          onStartSummarizedChat={() => void contextControls.handleSummarizedChatClick()}
          onContinue={contextControls.handleContinue}
        />
      )}
      {interruptedTurn && (
        <InterruptedTurnNotice
          key={interruptedTurn.messageId}
          messageId={interruptedTurn.messageId}
          checkpoint={interruptedTurn.checkpoint}
          disabled={disabled || isGenerating}
          onResume={onResumeInterruptedTurn}
          onDismiss={onDismissInterruptedTurn}
        />
      )}
      <PinnedTodoPanel chatId={chatId} />
      <InputBar
        onSubmit={onSubmit}
        chatId={chatId}
        disabled={disabled}
        submitDisabled={contextControls.requiresDecision || isContextActionPending}
        isGenerating={isGenerating}
        onStop={onStop}
        thinkingEnabled={thinkingEnabled}
        reasoningEffort={reasoningEffort}
        onThinkingToggle={onThinkingToggle}
        onReasoningEffortChange={onReasoningEffortChange}
        reasoningVisible={reasoningVisible}
        contextInfo={contextInfo}
        imageToolIntent={imageToolIntent}
        onImageToolIntentChange={onImageToolIntentChange}
        activeModel={activeModel}
        agentExecutionMode={agentExecutionMode}
        selectedAgentId={selectedAgentId}
        agents={agents}
        isAgentListLoading={isAgentListLoading}
        onAgentExecutionModeChange={onAgentExecutionModeChange}
        onSelectedAgentIdChange={onSelectedAgentIdChange}
        workdir={workdir}
        onWorkdirClick={onOpenWorkdirPicker}
      />
      {workspaceSettings && onCloseWorkdirPicker && onSelectWorkdir ? (
        <WorkdirPickerDialog
          open={isWorkdirPickerOpen}
          initialPath={workdir || workspaceSettings.defaultWorkdir}
          defaultWorkdir={workspaceSettings.defaultWorkdir}
          recentWorkdirs={workspaceSettings.recentWorkdirs}
          onSelect={onSelectWorkdir}
          onClose={onCloseWorkdirPicker}
        />
      ) : null}
    </div>
  );
}
