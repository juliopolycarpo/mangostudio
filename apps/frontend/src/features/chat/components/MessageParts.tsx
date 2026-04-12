import type { MessagePart } from '@mangostudio/shared';
import { useI18n } from '@/hooks/use-i18n';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallBlock } from './ToolCallBlock';
import { SystemEventMarker } from './SystemEventMarker';

interface MessagePartsProps {
  parts: MessagePart[];
  messageId: string;
  isStreaming: boolean;
}

export function MessageParts({ parts, messageId, isStreaming }: MessagePartsProps) {
  const { t } = useI18n();
  let thinkingIdx = 0;

  return (
    <>
      {parts.map((part, idx) => {
        switch (part.type) {
          case 'thinking': {
            const segIdx = thinkingIdx++;
            const blockId = `${messageId}-thinking-${segIdx}`;
            const isLastThinking =
              isStreaming && !parts.slice(idx + 1).some((p) => p.type === 'thinking');
            return (
              <ThinkingBlock
                key={blockId}
                messageId={blockId}
                text={part.text}
                isStreaming={isLastThinking}
                segmentIndex={segIdx}
              />
            );
          }
          case 'tool_call': {
            const result = parts.find(
              (p) => p.type === 'tool_result' && p.toolCallId === part.toolCallId
            ) as Extract<MessagePart, { type: 'tool_result' }> | undefined;
            return (
              <ToolCallBlock
                key={part.toolCallId}
                name={part.name}
                args={part.args}
                result={result?.content ?? null}
                isError={result?.isError}
                isPending={isStreaming && !result}
              />
            );
          }
          case 'tool_result':
            return null;
          case 'text':
            return (
              <div
                key={`text-${idx}`}
                className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl"
              >
                <MarkdownContent
                  content={part.text}
                  isStreaming={isStreaming}
                  copyCodeLabel={t.chat.copyCode}
                  codeCopiedLabel={t.chat.codeCopied}
                />
                {isStreaming && idx === parts.length - 1 && (
                  <span className="inline-block w-0.5 h-[1em] bg-primary ml-0.5 align-middle animate-blink" />
                )}
              </div>
            );
          case 'system_event':
            return <SystemEventMarker key={`se-${idx}`} event={part.event} detail={part.detail} />;
          case 'error':
            return (
              <div
                key={`error-${idx}`}
                className="bg-error/10 border border-error/20 p-4 rounded-xl text-error text-sm font-body"
              >
                {part.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
