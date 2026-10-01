import type { ContextSettings } from '@mangostudio/shared/chat';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { messageKeys, useMessagesQuery } from '@/features/chat/queries';
import {
  flattenTranscript,
  type MessagesCache,
  transcriptPageSizes,
} from '@/features/chat/transcript-pages';
import {
  type BackgroundRun,
  dropBackgroundRun,
  registerBackgroundRun,
} from '@/features/chat/transcript-read-ahead';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';

interface UseChatPageMessagesParams {
  readonly chatId: string | null;
  readonly seedContextInfo?: (chatId: string, info: ContextInfo) => void;
}

/**
 * Background loading of older pages, kept apart from `OlderMessages.load` so a
 * read-ahead never looks like the reader asking: it does not show the loading
 * indicator, never surfaces an error, and is never retried.
 */
export interface ReadAheadHandle {
  /** Row count of each loaded page, oldest page first. */
  readonly pageSizes: readonly number[];
  /**
   * Starts fetching one older page in the background. False when none can be
   * started: nothing older, a fetch already running, or the last read-ahead
   * failed (it stays off until a page lands another way).
   */
  readonly start: () => boolean;
  /** Aborts the background fetch, unless the reader is waiting on it. */
  readonly abort: () => void;
  /** A background fetch is running. */
  readonly isRunning: () => boolean;
  /**
   * The transcript is being fetched, for any reason. A read-ahead cannot start
   * meanwhile, so it asks again when this goes false.
   */
  readonly busy: boolean;
}

/** What the transcript needs to load the messages above the ones it holds. */
export interface OlderMessages {
  /** There are older messages on the server than the ones loaded. */
  readonly hasMore: boolean;
  /**
   * The reader is waiting on an older page right now. A page read ahead in the
   * background is not this: only one the reader asked for, or reached the top
   * of the loaded rows while it was still in flight.
   */
  readonly isLoading: boolean;
  /** The last attempt at an older page failed; asking again is up to the reader. */
  readonly failed: boolean;
  /**
   * Fetches the next older page for a reader who needs it. Safe to call on every
   * scroll: it does nothing while any refetch is running or once the oldest
   * message is loaded, and while a page is already in flight (read-ahead
   * included) it joins that fetch and marks the reader as waiting for it.
   */
  readonly load: () => void;
  /** Background loading; absent where the transcript does no read-ahead. */
  readonly ahead?: ReadAheadHandle;
}

/**
 * The chat page's transcript: the loaded messages in chronological order, the
 * query status, and the handle for loading older pages.
 *
 * The chat opens on its newest page; older pages are loaded on demand through
 * `older.load()`, and ahead of the reader through `older.ahead`.
 *
 * @example
 * const { messages, status, older } = useChatPageMessages({ chatId });
 * if (reachedTop) older.load();
 */
export function useChatPageMessages({ chatId, seedContextInfo }: UseChatPageMessagesParams) {
  const queryClient = useQueryClient();
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
  const pageSizes = useMemo(() => transcriptPageSizes(data), [data]);

  // The reader is waiting on the page being fetched. The query's own
  // `isFetchingNextPage` is true for a background read too, so it alone cannot
  // drive the loading indicator.
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const markWaiting = useCallback(() => {
    waitingRef.current = true;
    setWaiting(true);
  }, []);
  useEffect(() => {
    if (!waiting || isFetchingNextPage) return;
    waitingRef.current = false;
    setWaiting(false);
  }, [waiting, isFetchingNextPage]);

  const queryKey = useMemo(() => messageKeys.list(chatId ?? ''), [chatId]);
  const backgroundRef = useRef<BackgroundRun | null>(null);
  const failedAtRef = useRef<{ chatId: string | null; pages: number } | null>(null);

  // A refetch is not a place to start a page: it would be built from the cache
  // the refetch is about to replace. The load simply waits; the feed asks again
  // once it ends and the reader is still at the top. A page already in flight
  // because of a read-ahead is the reader's page now: join it, and show it.
  const load = useCallback(() => {
    if (!chatId || !hasNextPage) return;
    if (queryClient.isFetching({ queryKey, exact: true }) > 0) {
      if (!backgroundRef.current) return;
      backgroundRef.current.readerWaiting = true;
      markWaiting();
      return;
    }
    markWaiting();
    // `cancelRefetch: false`: a second call while the page is in flight joins
    // it rather than cancelling it and starting over.
    void fetchNextPage({ cancelRefetch: false });
  }, [chatId, hasNextPage, queryClient, queryKey, markWaiting, fetchNextPage]);

  const startReadAhead = useCallback(() => {
    if (!chatId || backgroundRef.current) return false;
    const state = queryClient.getQueryState<MessagesCache>(queryKey);
    const cache = state?.data;
    if (!cache || state.fetchStatus !== 'idle' || state.status === 'error') return false;
    if (cache.pages.at(-1)?.nextCursor == null) return false;
    const failedAt = failedAtRef.current;
    if (failedAt?.chatId === chatId && failedAt.pages === cache.pages.length) return false;
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (!query) return false;

    const run: BackgroundRun = {
      controller: new AbortController(),
      failed: false,
      readerWaiting: false,
    };
    backgroundRef.current = run;
    registerBackgroundRun(query, run);
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      // A refetch can cancel the fetch without ending the request: make sure
      // nothing keeps running once the run is over (a no-op when it finished).
      run.controller.abort();
      dropBackgroundRun(query, run);
      if (backgroundRef.current === run) backgroundRef.current = null;
      if (!run.failed) return;
      const pages = queryClient.getQueryData<MessagesCache>(queryKey)?.pages.length ?? 0;
      failedAtRef.current = { chatId, pages };
    });
    return true;
  }, [chatId, queryClient, queryKey, fetchNextPage]);

  const abortReadAhead = useCallback(() => {
    if (!waitingRef.current) backgroundRef.current?.controller.abort();
  }, []);
  const isReadingAhead = useCallback(() => backgroundRef.current !== null, []);

  // Leaving the chat (a switch or the page unmounting) ends whatever was being
  // read ahead for it, so hopping between chats never queues requests.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for the chat that is being left
  useEffect(
    () => () => {
      backgroundRef.current?.controller.abort();
    },
    [chatId]
  );

  const ahead = useMemo<ReadAheadHandle>(
    () => ({
      pageSizes,
      start: startReadAhead,
      abort: abortReadAhead,
      isRunning: isReadingAhead,
      busy: isFetching,
    }),
    [pageSizes, startReadAhead, abortReadAhead, isReadingAhead, isFetching]
  );
  const older = useMemo<OlderMessages>(
    () => ({
      hasMore: hasNextPage,
      isLoading: waiting && isFetchingNextPage,
      failed: isFetchNextPageError,
      load,
      ahead,
    }),
    [hasNextPage, waiting, isFetchingNextPage, isFetchNextPageError, load, ahead]
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
