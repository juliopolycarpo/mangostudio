import type { Message } from '@mangostudio/shared/chat';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Sparkles } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import * as motion from 'motion/react-m';
import {
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type WheelEvent,
} from 'react';

import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';

import { useChatAutoFollow } from '../hooks/use-chat-auto-follow';
import { useChatFileCheckpoints } from '../hooks/use-chat-file-checkpoints';
import type { OlderMessages } from '../hooks/use-chat-page-state';
import { useModelDisplayNames } from '../hooks/use-model-display-names';
import { useTranscriptReadAhead } from '../hooks/use-transcript-read-ahead';
import { CHAT_COLUMN_CLASS, CHAT_GUTTER_X_CLASS } from '../lib/chat-column';
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
    <EmptyState
      icon={<Sparkles size={ICON_LG} />}
      title={t.chat.feed.emptyTitle}
      hint={t.chat.feed.emptySubtitle}
      className="h-full"
    />
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
  // Likewise once for the feed: each turn header names its model the way the
  // composer does, and a lookup per row would be a catalog observer per row.
  const modelNames = useModelDisplayNames();
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
      // Full width, so a wheel or a touch in the margins beside the column still
      // scrolls the feed; the column itself is the one the composer sits in.
      //
      // The bottom padding is the gap above the composer, and it lives here
      // rather than on the composer's footer: padding on the footer was a strip
      // of canvas between the scroller's clip edge and the frame, with text cut
      // through the middle of it. Here the clip edge is the composer's own border.
      className={`hide-scrollbar min-h-0 flex-1 overflow-y-auto pt-4 pb-6 sm:pt-6 sm:pb-8 md:pt-8 md:pb-10 ${CHAT_GUTTER_X_CLASS}`}
    >
      {messages.length === 0 && <EmptyFeed />}

      {/* Out of flow (zero height, stuck to the top): an in-flow row would push
          every message down when it appears and again when it goes. */}
      {older?.isLoading && (
        <div className="sticky top-0 z-10 flex h-0 justify-center pointer-events-none">
          <output className="flex h-8 items-center gap-2 rounded-md border border-stroke bg-surface-raised px-3 text-xs font-medium text-fg-muted shadow-popover">
            <Spinner size="sm" />
            {t.chat.feed.loadingOlder}
          </output>
        </div>
      )}

      {messages.length > 0 && (
        <div
          ref={contentRef}
          className={CHAT_COLUMN_CLASS}
          style={{
            height: `${totalSize}px`,
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
              modelNames={modelNames}
            />
          ))}
        </div>
      )}

      <AnimatePresence>
        {showScrollButton && messages.length > 0 && (
          // Zero height and out of the pointer's way, stuck to the foot of the
          // port at the column's right edge: the prose is capped well short of
          // that edge, so the button sits beside the lines being read instead of
          // on top of them, as it did centred.
          <motion.div
            key="scroll-to-bottom"
            {...fadeRise}
            className={`${CHAT_COLUMN_CLASS} pointer-events-none sticky bottom-3 z-10 flex h-0 items-end justify-end`}
          >
            <button
              type="button"
              onClick={scrollToBottom}
              className="pointer-events-auto flex h-8 cursor-pointer items-center gap-2 rounded-sm border border-stroke bg-control px-3 text-xs font-medium text-fg shadow-popover transition-colors hover:bg-control-hover active:bg-control-pressed"
              title={t.chat.scrollToBottom}
            >
              <ArrowDown size={ICON_SM} />
              {t.chat.scrollToBottom}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
