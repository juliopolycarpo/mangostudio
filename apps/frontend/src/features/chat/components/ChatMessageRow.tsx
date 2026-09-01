import type { Message } from '@mangostudio/shared';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import { memo } from 'react';
import type { ToolIdentityResolver } from '@/features/environments/identity/use-tool-identities';
import { AssistantMessageBlock } from './AssistantMessageBlock';
import { isImageInteraction } from './message-content';
import { UserMessageBubble } from './UserMessageBubble';

interface ChatMessageRowProps {
  message: Message;
  index: number;
  start: number;
  measureRef: (element: Element | null) => void;
  chatId?: string | null;
  /** Present when this turn has a revertable manifest; absent means no affordance. */
  fileCheckpoint?: ChatFileCheckpointSummary;
  /** Present only on the last row while question cards may be answered. */
  onQuestionSubmit?: (prompt: string) => void;
  /** Resolved once per feed by `ChatFeed`; only an assistant row reads it. */
  toolIdentities: ToolIdentityResolver;
}

/**
 * Renders one virtualized chat row: the absolute positioning + measurement
 * wrapper that delegates to the user or assistant presentation.
 *
 * Memoized so streaming updates to the latest message do not re-render the
 * settled rows above it — only the row whose message object changed re-renders.
 *
 * Usage: <ChatMessageRow message={msg} index={i} start={top} measureRef={measure} toolIdentities={identities} />
 */
function ChatMessageRowComponent({
  message,
  index,
  start,
  measureRef,
  chatId,
  fileCheckpoint,
  onQuestionSubmit,
  toolIdentities,
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
      {/* A plain div: this carried a `motion.div` whose `initial={false}` meant
          it rendered straight at its `animate` target and never played, so
          every virtualized row paid for a motion component that could not
          animate. New rows arrive at the foot of a feed that is already
          scrolling to meet them; there is no entrance to stage. */}
      <div
        className={`flex flex-col gap-2 ${isUser ? 'items-end ml-auto max-w-[92%] sm:max-w-[85%] md:max-w-[80%]' : 'items-start mr-auto max-w-full'}`}
      >
        {isUser ? (
          <UserMessageBubble msg={message} isImageTurn={isImageTurn} />
        ) : (
          <AssistantMessageBlock
            msg={message}
            isImageTurn={isImageTurn}
            chatId={chatId}
            fileCheckpoint={fileCheckpoint}
            onQuestionSubmit={onQuestionSubmit}
            toolIdentities={toolIdentities}
          />
        )}
      </div>
    </div>
  );
}

export const ChatMessageRow = memo(ChatMessageRowComponent);
