import type { ContextSettings } from '@mangostudio/shared/chat';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useMessagesQuery } from '@/features/chat/queries';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';

interface UseChatPageMessagesParams {
  readonly chatId: string | null;
  readonly seedContextInfo?: (chatId: string, info: ContextInfo) => void;
}

export function useChatPageMessages({ chatId, seedContextInfo }: UseChatPageMessagesParams) {
  const { data, status } = useMessagesQuery(chatId);
  const firstPageContextInfo = data?.pages[0]?.contextInfo;

  useEffect(() => {
    if (chatId && firstPageContextInfo && seedContextInfo) {
      seedContextInfo(chatId, firstPageContextInfo);
    }
  }, [chatId, firstPageContextInfo, seedContextInfo]);

  const messages = useMemo(() => data?.pages.flatMap((page) => page.messages) ?? [], [data?.pages]);

  return { messages, status };
}

interface UseChatContextControlsParams {
  readonly chatId: string | null;
  readonly contextInfo?: ContextInfo | null;
  readonly contextSettings: ContextSettings;
  readonly isContextActionPending: boolean;
  readonly onCompactCurrentChat: () => Promise<void>;
  readonly onStartSummarizedChat: () => Promise<void>;
}

export function useChatContextControls({
  chatId,
  contextInfo,
  contextSettings,
  isContextActionPending,
  onCompactCurrentChat,
  onStartSummarizedChat,
}: UseChatContextControlsParams) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [continuedWarningKey, setContinuedWarningKey] = useState<string | null>(null);
  const handledAutoWarningKeyRef = useRef<string | null>(null);

  const warningKey = useMemo(() => {
    if (!chatId || !contextInfo) return null;
    return `${chatId}:${contextInfo.mode}:${contextInfo.estimatedInputTokens}`;
  }, [chatId, contextInfo]);

  const hasContextWarning =
    !!contextInfo && contextInfo.estimatedUsageRatio >= contextSettings.warningThreshold;
  const isDanger =
    !!contextInfo && contextInfo.estimatedUsageRatio >= contextSettings.dangerThreshold;
  const isCritical =
    !!contextInfo && contextInfo.estimatedUsageRatio >= contextSettings.hardStopThreshold;
  const requiresDecision =
    hasContextWarning &&
    contextSettings.compactionBehavior === 'ask' &&
    warningKey !== null &&
    warningKey !== continuedWarningKey;
  const warningMessage = isCritical
    ? t.chat.context.critical
    : isDanger
      ? t.chat.context.danger
      : t.chat.context.warning;

  useEffect(() => {
    if (!hasContextWarning || !warningKey || isContextActionPending) return;
    if (handledAutoWarningKeyRef.current === warningKey) return;

    const runAutoAction = async () => {
      try {
        if (contextSettings.compactionBehavior === 'auto_compact_current_chat') {
          await onCompactCurrentChat();
          toast(t.chat.context.compactedSuccess, 'success');
        }
        if (contextSettings.compactionBehavior === 'continue_with_summary_new_chat') {
          await onStartSummarizedChat();
          toast(t.chat.context.summarizedChatSuccess, 'success');
        }
      } catch {
        const message =
          contextSettings.compactionBehavior === 'continue_with_summary_new_chat'
            ? t.chat.context.summarizedChatFailed
            : t.chat.context.compactFailed;
        toast(message, 'error');
      }
    };

    if (
      contextSettings.compactionBehavior === 'auto_compact_current_chat' ||
      contextSettings.compactionBehavior === 'continue_with_summary_new_chat'
    ) {
      handledAutoWarningKeyRef.current = warningKey;
      void runAutoAction();
    }
  }, [
    contextSettings.compactionBehavior,
    hasContextWarning,
    isContextActionPending,
    onCompactCurrentChat,
    onStartSummarizedChat,
    t.chat.context.compactFailed,
    t.chat.context.compactedSuccess,
    t.chat.context.summarizedChatFailed,
    t.chat.context.summarizedChatSuccess,
    toast,
    warningKey,
  ]);

  const handleCompactClick = async () => {
    try {
      await onCompactCurrentChat();
      toast(t.chat.context.compactedSuccess, 'success');
    } catch {
      toast(t.chat.context.compactFailed, 'error');
    }
  };

  const handleSummarizedChatClick = async () => {
    try {
      await onStartSummarizedChat();
      toast(t.chat.context.summarizedChatSuccess, 'success');
    } catch {
      toast(t.chat.context.summarizedChatFailed, 'error');
    }
  };

  return {
    requiresDecision,
    warningMessage,
    handleCompactClick,
    handleSummarizedChatClick,
    handleContinue: () => {
      setContinuedWarningKey(warningKey);
    },
  };
}
