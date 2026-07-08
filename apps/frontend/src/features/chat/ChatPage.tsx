import type { ReasoningEffort } from '@mangostudio/shared';
import type { AgentExecutionMode, AgentProfile } from '@mangostudio/shared/agents';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type { ContextInfo, FallbackNotice } from '@/features/generation/types';
import { authClient } from '@/lib/auth-client';
import { ChatPageContent } from './components/ChatPageContent';
import { ChatContextDecisionNotice, ChatFallbackNotice } from './components/ChatPageNotices';
import { InputBar } from './components/InputBar';
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
  agentExecutionMode?: AgentExecutionMode;
  selectedAgentId?: string;
  agents?: ReadonlyArray<AgentProfile>;
  isAgentListLoading?: boolean;
  onAgentExecutionModeChange?: (mode: AgentExecutionMode) => void;
  onSelectedAgentIdChange?: (agentId: string) => void;
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
  agentExecutionMode = 'chat',
  selectedAgentId = 'default',
  agents = [],
  isAgentListLoading = false,
  onAgentExecutionModeChange,
  onSelectedAgentIdChange,
}: ChatPageProps) {
  const { messages, status } = useChatPageMessages({ chatId, seedContextInfo });
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
        agentExecutionMode={agentExecutionMode}
        selectedAgentId={selectedAgentId}
        agents={agents}
        isAgentListLoading={isAgentListLoading}
        onAgentExecutionModeChange={onAgentExecutionModeChange}
        onSelectedAgentIdChange={onSelectedAgentIdChange}
      />
    </div>
  );
}
