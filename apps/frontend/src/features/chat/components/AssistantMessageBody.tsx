import type { Message } from '@mangostudio/shared';
import { useI18n } from '@/hooks/use-i18n';
import { MessageParts } from './MessageParts';
import { messagePartsFromMessage } from './message-content';

interface BodyProps {
  msg: Message;
  /** Threaded down so an approval card knows which chat to answer against. */
  chatId?: string | null;
}

/**
 * Renders the in-flight assistant body: a labelled skeleton while there is no
 * content yet (or for image turns), otherwise the live, streaming parts.
 *
 * Usage: <StreamingMessageBody msg={msg} isImageTurn={isImageTurn} />
 */
export function StreamingMessageBody({
  msg,
  chatId = null,
  isImageTurn,
}: BodyProps & { isImageTurn: boolean }) {
  const { t } = useI18n();
  const parts = messagePartsFromMessage(msg);
  const hasContent = parts.some(
    (p) =>
      p.type === 'thinking' ||
      p.type === 'text' ||
      p.type === 'tool_call' ||
      p.type === 'mcp_elicitation' ||
      p.type === 'external_activity' ||
      p.type === 'external_approval'
  );

  if (isImageTurn || !hasContent) {
    return (
      <div className="flex max-w-2xl flex-col gap-2 pl-4">
        <span className="animate-pulse text-sm font-medium text-on-surface">
          {isImageTurn ? t.chat.feed.generatingImage : t.thinking.streaming}
        </span>
        {isImageTurn ? (
          <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-container-highest">
            <div className="h-full w-1/2 animate-[slide_1s_ease-in-out_infinite_alternate] bg-primary"></div>
          </div>
        ) : (
          <div className="skeleton-pulse mt-1">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        )}
      </div>
    );
  }

  return <MessageParts parts={parts} messageId={msg.id} chatId={chatId} isStreaming />;
}

/**
 * Renders a completed assistant body, with a "no response" placeholder when the
 * turn produced neither text nor tool calls.
 *
 * Usage: <CompletedMessageBody msg={msg} />
 */
export function CompletedMessageBody({
  msg,
  chatId = null,
  onQuestionSubmit,
}: BodyProps & { onQuestionSubmit?: (prompt: string) => void }) {
  const { t } = useI18n();
  const parts = messagePartsFromMessage(msg);
  const hasTextOrTools = parts.some((p) => p.type === 'text' || p.type === 'tool_call');

  return (
    <>
      <MessageParts
        parts={parts}
        messageId={msg.id}
        chatId={chatId}
        isStreaming={false}
        onQuestionSubmit={onQuestionSubmit}
      />
      {!hasTextOrTools && (
        <div className="max-w-2xl pl-4 font-body text-sm leading-relaxed">
          <span className="italic text-on-surface-variant/50">{t.chat.feed.noResponse}</span>
        </div>
      )}
    </>
  );
}
