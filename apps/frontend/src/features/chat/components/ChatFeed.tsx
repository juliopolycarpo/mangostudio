import type { Message } from '@mangostudio/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { useChatAutoFollow } from '../hooks/use-chat-auto-follow';
import { useChatFileCheckpoints } from '../hooks/use-chat-file-checkpoints';
import { ChatMessageRow } from './ChatMessageRow';

const ESTIMATED_ROW_HEIGHT_PX = 150;
const ROW_OVERSCAN = 5;

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
  onQuestionSubmit,
}: {
  chatId: string | null;
  messages: Message[];
  /** Present only while question cards may be answered (no generation running). */
  onQuestionSubmit?: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const { fadeRise } = useMotionPresets();
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

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: ROW_OVERSCAN,
  });

  return (
    <section
      ref={parentRef}
      onScroll={handleScroll}
      className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6 md:py-8 hide-scrollbar max-w-5xl mx-auto w-full"
    >
      {messages.length === 0 && <EmptyFeed />}

      {messages.length > 0 && (
        <div
          ref={contentRef}
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
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
