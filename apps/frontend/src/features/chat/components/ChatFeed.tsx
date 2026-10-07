import type { Message } from '@mangostudio/shared/chat';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Loader2, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type WheelEvent,
} from 'react';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { useChatAutoFollow } from '../hooks/use-chat-auto-follow';
import { useChatFileCheckpoints } from '../hooks/use-chat-file-checkpoints';
import type { OlderMessages } from '../hooks/use-chat-page-state';
import { useTranscriptReadAhead } from '../hooks/use-transcript-read-ahead';
import type { ReaderPosition } from '../transcript-read-ahead';
import { ChatMessageRow } from './ChatMessageRow';

/** The height the virtualizer assumes for a row it has not measured yet. */
export const ESTIMATED_ROW_HEIGHT_PX = 150;
const ROW_OVERSCAN = 5;
/**
 * How close to the top of what is loaded the reader gets before the next older
 * page is requested: far enough that a page usually lands before they arrive.
 */
const LOAD_OLDER_WITHIN_PX = 3 * ESTIMATED_ROW_HEIGHT_PX;

/** Centered empty state shown when a chat has no messages yet. */
function EmptyFeed() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full text-on-surface-variant/50 px-4">
      <Sparkles size={48} className="mb-4 opacity-50" />
      <p className="text-lg font-headline text-center">{t.chat.feed.emptyTitle}</p>
      <p className="text-xs mt-2 text-on-surface-variant/40 text-center">
        {t.chat.feed.emptySubtitle}
      </p>
    </div>
  );
}

/**
 * Virtualized chat transcript. Owns scroll-follow behavior and row
 * virtualization, delegating per-message rendering to ChatMessageRow.
 *
 * Usage: <ChatFeed chatId={chatId} messages={messages} />
 */
export function ChatFeed({
  chatId,
  messages,
  older,
  isGenerating = false,
  onQuestionSubmit,
}: {
  chatId: string | null;
  /** The loaded messages, chronological: the newest page is at the end. */
  messages: Message[];
  /**
   * Loads the messages above `messages`. The feed calls `load()` whenever the
   * reader is near the top of what is loaded; absent for a transcript that has
   * nothing older to load.
   */
  older?: OlderMessages;
  /** A turn is streaming: the feed starts no background page load meanwhile. */
  isGenerating?: boolean;
  /** Present only while question cards may be answered (no generation running). */
  onQuestionSubmit?: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const { fadeRise } = useMotionPresets();
  // Resolved once for the whole feed and threaded down to every row: rows used
  // to call this themselves, so an N-message chat registered N react-query
  // observers and N realtime-invalidation listeners for a resolver almost none
  // of them needed.
  const toolIdentities = useToolIdentities();
  const { data: checkpointData } = useChatFileCheckpoints(chatId);
  // The summary is both the revert affordance's gate and what the confirmation
  // needs to say about the writes it cannot undo, so the row carries the entry
  // rather than a boolean the dialog would then have to look up again.
  const checkpointsByMessage = useMemo(
    () => new Map((checkpointData?.checkpoints ?? []).map((entry) => [entry.messageId, entry])),
    [checkpointData]
  );
  const { parentRef, contentRef, showScrollButton, handleScroll, scrollToBottom } =
    useChatAutoFollow(chatId, messages);

  const getScrollElement = useCallback(() => parentRef.current, [parentRef]);
  const getItemKey = useCallback((index: number) => messages[index]?.id ?? index, [messages]);
  const estimateSize = useCallback(() => ESTIMATED_ROW_HEIGHT_PX, []);

  // A transcript opens at its newest message, so the virtualizer starts there
  // too: its first range is the bottom rows, not the top rows it used to lay
  // out — markdown and all — only for the follow to scroll them away. It starts
  // from wherever the port actually is once the follow hook's opening jump has
  // run, so it waits one commit for that: the first commit renders no rows
  // either way (the port has no size yet), and reading the real position
  // rather than an estimate needs no later `scroll` event to correct it —
  // which a chat short enough to fit the port would never send. A chat switch
  // that keeps this feed mounted does not re-read it and still lands through
  // the hook's jump.
  const [portPositioned, setPortPositioned] = useState(false);
  const readPortOffset = useCallback(() => parentRef.current?.scrollTop ?? 0, [parentRef]);
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    enabled: portPositioned,
    initialOffset: readPortOffset,
    // While the view sits at the end, a row that changes size keeps the end in
    // place rather than the rows above it. Without this, bottom rows growing
    // in place (the markdown renderer landing, say) only extend the content
    // below the view until the follow hook catches the resize a frame later,
    // and the virtualizer's own compensation — computed from the offset it
    // read before the hook's jump — can undo that jump. With it, both writers
    // aim at the bottom. It does not follow on its own: appending never
    // scrolls here (`followOnAppend` stays off), the hook owns that.
    anchorTo: 'end',
    overscan: ROW_OVERSCAN,
  });
  // Declared after the follow hook, so it runs after the opening jump.
  useLayoutEffect(() => setPortPositioned(true), []);
  // A disabled virtualizer reports no size, so until it starts the transcript
  // takes the size it will estimate once it does: the opening jump then lands
  // where the virtualizer's own first layout puts the bottom.
  const totalSize = portPositioned
    ? rowVirtualizer.getTotalSize()
    : messages.length * ESTIMATED_ROW_HEIGHT_PX;

  // Reads where the port is *now*, not where this render saw it: the opening
  // jump and a chat switch both move it after the render that scheduled this.
  // Rows prepended above the reader are kept in place by the virtualizer
  // (`anchorTo: 'end'` re-anchors on the row at the top of the view), so a page
  // landing does not itself bring the reader back within reach of the next one.
  const loadOlder = older?.load;
  const hasOlder = older?.hasMore ?? false;
  const olderFailed = older?.failed ?? false;
  const transcriptBusy = older?.ahead?.busy ?? false;
  const requestOlderNearTop = useCallback(() => {
    const port = parentRef.current;
    if (!loadOlder || !hasOlder || !port) return;
    if (port.scrollTop <= LOAD_OLDER_WITHIN_PX) loadOlder();
  }, [loadOlder, hasOlder, parentRef]);
  // A scroll event covers the reader moving; this covers everything that is not
  // one: the chat opening short enough that nothing scrolls, a page landing
  // that still leaves the reader near the top, a refetch ending. After a failed
  // page it stays quiet, or a dead connection would be asked again as fast as
  // it refuses; the reader scrolling is what tries again. While the transcript
  // is being fetched an ask would do nothing, so it waits for the fetch to end:
  // `transcriptBusy` going false is what re-asks a reader left at the top by a
  // refetch.
  useEffect(() => {
    if (!olderFailed && !transcriptBusy) requestOlderNearTop();
  }, [olderFailed, transcriptBusy, requestOlderNearTop, messages.length]);
  // Older pages are also fetched ahead of the reader, after the newest page has
  // rendered; see `useTranscriptReadAhead`. It reads the reader's place from the
  // virtualizer at the moment it decides, not from a render.
  const readPosition = useCallback(
    (): ReaderPosition => ({
      firstVisibleIndex: rowVirtualizer.range?.startIndex ?? 0,
      offsetPx: parentRef.current?.scrollTop ?? 0,
      viewportPx: parentRef.current?.clientHeight ?? 0,
    }),
    [rowVirtualizer, parentRef]
  );
  useTranscriptReadAhead({
    chatId,
    ready: portPositioned && messages.length > 0,
    paused: isGenerating || messages.at(-1)?.isGenerating === true,
    older,
    parentRef,
    readPosition,
  });
  const handleFeedScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      handleScroll(event);
      requestOlderNearTop();
    },
    [handleScroll, requestOlderNearTop]
  );

  // At the very top the port cannot scroll further, so a reader pushing up
  // sends no scroll event: without this, a page that failed there could only be
  // retried by scrolling away and back. The ask is idempotent, so a gesture that
  // sends many of these still starts one request.
  const handleFeedWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.deltaY < 0) requestOlderNearTop();
    },
    [requestOlderNearTop]
  );

  return (
    <section
      ref={parentRef}
      onScroll={handleFeedScroll}
      onWheel={handleFeedWheel}
      onTouchMove={requestOlderNearTop}
      className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6 md:py-8 hide-scrollbar max-w-5xl mx-auto w-full"
    >
      {messages.length === 0 && <EmptyFeed />}

      {/* Out of flow (zero height, stuck to the top): an in-flow row would push
          every message down when it appears and again when it goes. */}
      {older?.isLoading && (
        <div className="sticky top-0 z-10 flex h-0 justify-center pointer-events-none">
          <output className="glass-elevated flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-on-surface-variant border border-outline-variant/30">
            <Loader2 size={13} className="animate-spin" />
            {t.chat.feed.loadingOlder}
          </output>
        </div>
      )}

      {messages.length > 0 && (
        <div
          ref={contentRef}
          style={{
            height: `${totalSize}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => (
            <ChatMessageRow
              key={virtualRow.key}
              message={messages[virtualRow.index]}
              index={virtualRow.index}
              start={virtualRow.start}
              measureRef={rowVirtualizer.measureElement}
              chatId={chatId}
              fileCheckpoint={checkpointsByMessage.get(messages[virtualRow.index]?.id ?? '')}
              onQuestionSubmit={
                virtualRow.index === messages.length - 1 ? onQuestionSubmit : undefined
              }
              toolIdentities={toolIdentities}
            />
          ))}
        </div>
      )}

      <AnimatePresence>
        {showScrollButton && messages.length > 0 && (
          <motion.button
            key="scroll-to-bottom"
            {...fadeRise}
            type="button"
            onClick={scrollToBottom}
            className="glass-elevated sticky bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-on-surface-variant border border-outline-variant/30 cursor-pointer hover:border-outline-variant/50 hover:text-on-surface transition-colors duration-200"
            title={t.chat.scrollToBottom}
          >
            <ArrowDown size={13} />
            {t.chat.scrollToBottom}
          </motion.button>
        )}
      </AnimatePresence>
    </section>
  );
}
