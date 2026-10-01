import type { ContextSettings } from '@mangostudio/shared/chat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useMessagesQuery } from '@/features/chat/queries';
import { flattenTranscript } from '@/features/chat/transcript-pages';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';

interface UseChatPageMessagesParams {
  readonly chatId: string | null;
  readonly seedContextInfo?: (chatId: string, info: ContextInfo) => void;
}

/** What the transcript needs to load the messages above the ones it holds. */
export interface OlderMessages {
  /** There are older messages on the server than the ones loaded. */
  readonly hasMore: boolean;
  /** An older page is being fetched right now. */
  readonly isLoading: boolean;
  /** The last attempt at an older page failed; asking again is up to the reader. */
  readonly failed: boolean;
  /**
   * Fetches the next older page. Safe to call on every scroll: it does nothing
   * while a page is in flight, while any refetch is running, or once the
   * oldest message is loaded.
   */
  readonly load: () => void;
}

/**
 * The chat page's transcript: the loaded messages in chronological order, the
 * query status, and the handle for loading older pages.
 *
 * The chat opens on its newest page; older pages are loaded on demand through
 * `older.load()`.
 *
 * @example
 * const { messages, status, older } = useChatPageMessages({ chatId });
 * if (reachedTop) older.load();
 */
export function useChatPageMessages({ chatId, seedContextInfo }: UseChatPageMessagesParams) {
  const {
    data,
    status,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = useMessagesQuery(chatId);
  const firstPageContextInfo = data?.pages[0]?.contextInfo;

  useEffect(() => {
    if (chatId && firstPageContextInfo && seedContextInfo) {
      seedContextInfo(chatId, firstPageContextInfo);
    }
  }, [chatId, firstPageContextInfo, seedContextInfo]);

  const messages = useMemo(() => flattenTranscript(data), [data]);

  // A refetch is not a place to start a page: it would be built from the cache
  // the refetch is about to replace. The load simply waits; the feed asks again
  // once `isFetching` ends and the reader is still at the top.
  const canLoadOlder = hasNextPage && !isFetching;
  const load = useCallback(() => {
    // `cancelRefetch: false`: a second call while the page is in flight joins
    // it rather than cancelling it and starting over.
    if (canLoadOlder) void fetchNextPage({ cancelRefetch: false });
  }, [canLoadOlder, fetchNextPage]);
  const older = useMemo<OlderMessages>(
    () => ({
      hasMore: hasNextPage,
      isLoading: isFetchingNextPage,
      failed: isFetchNextPageError,
      load,
    }),
    [hasNextPage, isFetchingNextPage, isFetchNextPageError, load]
  );

  return { messages, status, older };
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
  const isAutoBehavior =
    contextSettings.compactionBehavior === 'auto_compact_current_chat' ||
    contextSettings.compactionBehavior === 'continue_with_summary_new_chat';
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

    if (isAutoBehavior) {
      handledAutoWarningKeyRef.current = warningKey;
      void runAutoAction();
    }
  }, [
    contextSettings.compactionBehavior,
    isAutoBehavior,
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
    /**
     * The context warning is up and the settings answer it automatically. A
     * caller holding the automatic action back (see `isContextActionPending`)
     * reads this to hold turns too, so none starts before the action has run.
     */
    isAutoActionDue: hasContextWarning && warningKey !== null && isAutoBehavior,
    warningMessage,
    handleCompactClick,
    handleSummarizedChatClick,
    handleContinue: () => {
      setContinuedWarningKey(warningKey);
    },
  };
}
