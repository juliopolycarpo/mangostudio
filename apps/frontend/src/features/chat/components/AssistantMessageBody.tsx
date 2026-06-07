import type { Message } from '@mangostudio/shared';
import { useI18n } from '@/hooks/use-i18n';
import { MessageParts } from './MessageParts';
import { messagePartsFromMessage } from './message-content';

interface BodyProps {
  msg: Message;
}

/**
 * Renders the in-flight assistant body: a labelled skeleton while there is no
 * content yet (or for image turns), otherwise the live, streaming parts.
 *
 * Usage: <StreamingMessageBody msg={msg} isImageTurn={isImageTurn} />
 */
export function StreamingMessageBody({ msg, isImageTurn }: BodyProps & { isImageTurn: boolean }) {
  const { t } = useI18n();
  const parts = messagePartsFromMessage(msg);
  const hasContent = parts.some(
    (p) => p.type === 'thinking' || p.type === 'text' || p.type === 'tool_call'
  );

  if (isImageTurn || !hasContent) {
    return (
      <>
        <span className="text-sm font-medium text-on-surface animate-pulse">
          {isImageTurn ? t.chat.feed.generatingImage : t.thinking.streaming}
        </span>
        {isImageTurn ? (
          <div className="h-1 w-24 bg-surface-container-highest rounded-full overflow-hidden">
            <div className="h-full bg-primary w-1/2 animate-[slide_1s_ease-in-out_infinite_alternate]"></div>
          </div>
        ) : (
          <div className="skeleton-pulse mt-1">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        )}
      </>
    );
  }

  return <MessageParts parts={parts} messageId={msg.id} isStreaming />;
}

/**
 * Renders a completed assistant body, with a "no response" placeholder when the
 * turn produced neither text nor tool calls.
 *
 * Usage: <CompletedMessageBody msg={msg} />
 */
export function CompletedMessageBody({ msg }: BodyProps) {
  const { t } = useI18n();
  const parts = messagePartsFromMessage(msg);
  const hasTextOrTools = parts.some((p) => p.type === 'text' || p.type === 'tool_call');

  return (
    <>
      <MessageParts parts={parts} messageId={msg.id} isStreaming={false} />
      {!hasTextOrTools && (
        <div className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl">
          <span className="text-on-surface-variant/50 italic">{t.chat.feed.noResponse}</span>
        </div>
      )}
    </>
  );
}
