import type { Message, ReasoningEffort } from '@mangostudio/shared';
import type { AgentProfile } from '@mangostudio/shared/agents';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type {
  ExternalAgentTargetId,
  ExternalThreadUsage,
} from '@mangostudio/shared/external-agents';
import type { ModelUnavailableDetails } from '@mangostudio/shared/generation';
import { isTurnCheckpointPart, type TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { WorkspaceSettings } from '@mangostudio/shared/workspaces';
import { type ComponentProps, useCallback, useMemo } from 'react';
import type { ContextInfo, FallbackNotice } from '@/features/generation/types';
import { WorkspaceRail } from '@/features/workspace/rail/WorkspaceRail';
import { WorkdirPickerDialog } from '@/features/workspace/WorkdirPickerDialog';
import { authClient } from '@/lib/auth-client';
import { ChatPageContent } from './components/ChatPageContent';
import { ChatContextDecisionNotice, ChatFallbackNotice } from './components/ChatPageNotices';
import { DeprecatedModelNotice } from './components/DeprecatedModelNotice';
import { InputBar } from './components/InputBar';
import { InterruptedTurnNotice } from './components/InterruptedTurnNotice';
import { PinnedTodoPanel } from './components/PinnedTodoPanel';
import { useChatHasTurns } from './hooks/use-chat-has-turns';
import { useChatContextControls, useChatPageMessages } from './hooks/use-chat-page-state';
import { requestComposerFocus, setComposerDraft } from './lib/composer-draft-store';

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
  /** Vendor-reported thread usage for the active chat; absent until a turn reports it. */
  threadUsage?: ExternalThreadUsage | null;
  fallbackNotice?: FallbackNotice | null;
  seedContextInfo?: (chatId: string, info: ContextInfo) => void;
  contextSettings: ContextSettings;
  isContextActionPending: boolean;
  onCompactCurrentChat: () => Promise<void>;
  onStartSummarizedChat: () => Promise<void>;
  imageToolIntent: boolean;
  onImageToolIntentChange: (active: boolean) => void;
  activeModel?: string | null;
  selectedAgentId?: string;
  agents?: ReadonlyArray<AgentProfile>;
  isAgentListLoading?: boolean;
  onSelectedAgentIdChange?: (agentId: string) => void;
  /** Read-only here now: the hub names it, and the header owns changing it. */
  environmentId?: string | null;
  workdir?: string | null;
  /** Jumping to another chat from the empty-state hub's uncommitted-work card. */
  onSelectChat?: (chatId: string) => void;
  /** Everything the composer needs to render the right controls for the runner. */
  composer?: ComposerRunnerProps;
  workspaceSettings?: WorkspaceSettings;
  onWorkspacePanelWidthChange?: (width: number) => void;
  isWorkdirPickerOpen?: boolean;
  onOpenWorkdirPicker?: () => void;
  onCloseWorkdirPicker?: () => void;
  onSelectWorkdir?: (path: string) => void | Promise<void>;
  restrictToolsToWorkdirOverride?: boolean | null;
  onRestrictToolsToWorkdirOverrideChange?: (value: boolean | null) => void | Promise<void>;
  onResumeInterruptedTurn: (messageId: string, retryCallIds: string[]) => Promise<void>;
  onDismissInterruptedTurn: (messageId: string) => Promise<void>;
  /** The last send refused because the chat's model has a deprecated provider. */
  modelUnavailable?: ModelUnavailableDetails | null;
  onDismissModelUnavailable?: () => void;
  /**
   * Forks this chat onto the vendor's CLI. Passed in rather than resolved from
   * app context here, because this component is rendered in tests without a
   * provider and a hidden `useApp()` would make every one of them a context
   * test.
   */
  onContinueWithExternalRunner?: (targetId: ExternalAgentTargetId) => void;
  isForkingRunner?: boolean;
  /** False when the vendor CLI the notice would fork onto cannot start a turn. */
  migrationRunnerAvailable?: boolean;
}

/**
 * The runner-shaped half of the composer.
 *
 * Grouped rather than spread across a dozen sibling props: they are one
 * decision — which runner this chat has — and splitting them would let a caller
 * pass an external descriptor alongside a MangoStudio runner.
 */
type ComposerRunnerProps = Pick<
  ComponentProps<typeof InputBar>,
  | 'runner'
  | 'activeModels'
  | 'modelCatalog'
  | 'lockedProvider'
  | 'isModelSelectorDisabled'
  | 'onModelChange'
  | 'externalDescriptor'
  | 'externalModel'
  | 'externalEffort'
  | 'externalLevel'
  | 'externalRouting'
  | 'onExternalModelChange'
  | 'onExternalEffortChange'
  | 'onExternalPermissionsChange'
>;

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
  threadUsage = null,
  fallbackNotice,
  seedContextInfo,
  contextSettings,
  isContextActionPending,
  onCompactCurrentChat,
  onStartSummarizedChat,
  imageToolIntent,
  onImageToolIntentChange,
  activeModel = null,
  selectedAgentId = 'default',
  agents = [],
  isAgentListLoading = false,
  onSelectedAgentIdChange,
  environmentId = null,
  workdir = null,
  onSelectChat,
  composer,
  workspaceSettings = DEFAULT_WORKSPACE_SETTINGS,
  onWorkspacePanelWidthChange,
  isWorkdirPickerOpen = false,
  onOpenWorkdirPicker,
  onCloseWorkdirPicker,
  onSelectWorkdir,
  restrictToolsToWorkdirOverride = null,
  onRestrictToolsToWorkdirOverrideChange,
  onResumeInterruptedTurn,
  onDismissInterruptedTurn,
  modelUnavailable = null,
  onDismissModelUnavailable,
  onContinueWithExternalRunner,
  isForkingRunner = false,
  migrationRunnerAvailable = false,
}: ChatPageProps) {
  const { messages, status } = useChatPageMessages({ chatId, seedContextInfo });
  // Reads the same query as `messages` above; this is the conservative framing
  // (an unloaded transcript locks) rather than a bare `messages.length > 0`.
  const hasTurns = useChatHasTurns(chatId);
  const interruptedTurn = useMemo(() => findLatestInterruptedTurn(messages), [messages]);
  const { data: session } = authClient.useSession();
  const userName = session?.user?.name?.split(' ')[0] ?? '';
  // A starter fills the composer instead of sending: the point of a starter is
  // that you finish the sentence, and a one-click send spends a turn on a
  // prompt nobody read.
  const handleUsePrompt = useCallback(
    (prompt: string) => {
      setComposerDraft(chatId, prompt);
      requestComposerFocus();
    },
    [chatId]
  );
  const contextControls = useChatContextControls({
    chatId,
    contextInfo,
    contextSettings,
    isContextActionPending,
    onCompactCurrentChat,
    onStartSummarizedChat,
  });
  const railShowsTodos = workspaceSettings.sidePanel.visiblePanelIds.includes('todos');

  return (
    <>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <ChatPageContent
            chatId={chatId}
            messages={messages}
            status={status}
            hub={{
              chatId,
              userName,
              workdir,
              environmentId,
              ...(composer?.runner?.kind === 'external'
                ? { activeTargetId: composer.runner.targetId }
                : {}),
              ...(onOpenWorkdirPicker ? { onChooseWorkdir: onOpenWorkdirPicker } : {}),
              ...(onSelectChat ? { onSelectChat } : {}),
              onUsePrompt: handleUsePrompt,
            }}
            onQuestionSubmit={
              isGenerating || disabled || contextControls.requiresDecision || isContextActionPending
                ? undefined
                : onSubmit
            }
          />
          {fallbackNotice && <ChatFallbackNotice notice={fallbackNotice} />}
          {modelUnavailable?.reason === 'provider-deprecated' ? (
            <DeprecatedModelNotice
              details={modelUnavailable}
              isForking={isForkingRunner}
              runnerAvailable={migrationRunnerAvailable}
              onContinueWithRunner={(targetId) => onContinueWithExternalRunner?.(targetId)}
              onDismiss={() => onDismissModelUnavailable?.()}
            />
          ) : null}
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
          {/*
            The rail surfaces todos instead — but only when the user kept that
            panel visible, so the pinned panel stays the fallback rather than
            todos vanishing entirely.
          */}
          {!railShowsTodos ? <PinnedTodoPanel chatId={chatId} /> : null}
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
            threadUsage={threadUsage}
            imageToolIntent={imageToolIntent}
            onImageToolIntentChange={onImageToolIntentChange}
            activeModel={activeModel}
            selectedAgentId={selectedAgentId}
            agents={agents}
            isAgentListLoading={isAgentListLoading}
            onSelectedAgentIdChange={onSelectedAgentIdChange}
            hasTurns={hasTurns}
            workdir={workdir}
            {...composer}
          />
        </div>
        {chatId ? (
          <WorkspaceRail
            key={chatId}
            chatId={chatId}
            workdir={workdir}
            settings={workspaceSettings.sidePanel}
            onWidthChange={onWorkspacePanelWidthChange}
          />
        ) : null}
      </div>
      {onCloseWorkdirPicker && onSelectWorkdir ? (
        <WorkdirPickerDialog
          open={isWorkdirPickerOpen}
          chatId={chatId ?? undefined}
          initialPath={workdir || workspaceSettings.defaultWorkdir}
          defaultWorkdir={workspaceSettings.defaultWorkdir}
          recentWorkdirs={workspaceSettings.recentWorkdirs}
          showRestrictToolsOverride={Boolean(chatId && onRestrictToolsToWorkdirOverrideChange)}
          globalRestrictToolsToWorkdir={workspaceSettings.restrictToolsToWorkdir}
          restrictToolsToWorkdirOverride={restrictToolsToWorkdirOverride}
          onRestrictToolsToWorkdirOverrideChange={onRestrictToolsToWorkdirOverrideChange}
          onSelect={onSelectWorkdir}
          onClose={onCloseWorkdirPicker}
        />
      ) : null}
    </>
  );
}
