import type { Message } from '@mangostudio/shared';
import { motion } from 'motion/react';
import { memo } from 'react';
import { AssistantMessageBlock } from './AssistantMessageBlock';
import { isImageInteraction } from './message-content';
import { UserMessageBubble } from './UserMessageBubble';

interface ChatMessageRowProps {
  message: Message;
  index: number;
  start: number;
  measureRef: (element: Element | null) => void;
  chatId?: string | null;
  canRevertFileChanges?: boolean;
  /** Present only on the last row while question cards may be answered. */
  onQuestionSubmit?: (prompt: string) => void;
}

/**
 * Renders one virtualized chat row: the absolute positioning + measurement
 * wrapper that delegates to the user or assistant presentation.
 *
 * Memoized so streaming updates to the latest message do not re-render the
 * settled rows above it — only the row whose message object changed re-renders.
 *
 * Usage: <ChatMessageRow message={msg} index={i} start={top} measureRef={measure} />
 */
function ChatMessageRowComponent({
  message,
  index,
  start,
  measureRef,
  chatId,
  canRevertFileChanges,
  onQuestionSubmit,
}: ChatMessageRowProps) {
  const isImageTurn = isImageInteraction(message);
  const isUser = message.role === 'user';

  return (
    <div
      ref={measureRef}
      data-index={index}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${start}px)`,
        paddingBottom: 'var(--chat-message-gap)',
        willChange: 'transform',
        contain: 'layout style paint',
      }}
    >
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        className={`flex flex-col gap-2 ${isUser ? 'items-end ml-auto max-w-[92%] sm:max-w-[85%] md:max-w-[80%]' : 'items-start mr-auto max-w-full'}`}
      >
        {isUser ? (
          <UserMessageBubble msg={message} isImageTurn={isImageTurn} />
        ) : (
          <AssistantMessageBlock
            msg={message}
            isImageTurn={isImageTurn}
            chatId={chatId}
            canRevertFileChanges={canRevertFileChanges}
            onQuestionSubmit={onQuestionSubmit}
          />
        )}
      </motion.div>
    </div>
  );
}

export const ChatMessageRow = memo(ChatMessageRowComponent);
