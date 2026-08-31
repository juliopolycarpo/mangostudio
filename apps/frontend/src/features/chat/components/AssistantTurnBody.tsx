import type { MessagePart } from '@mangostudio/shared';
import { useI18n } from '@/hooks/use-i18n';
import type { TurnStatus } from '../lib/turn-status';
import { MessageParts } from './MessageParts';

interface AssistantTurnBodyProps {
  parts: MessagePart[];
  /** Derived once per row by `AssistantMessageBlock`, not recomputed here. */
  status: TurnStatus;
  messageId: string;
  isStreaming: boolean;
  /** True for an image turn, whose picture is its whole body. */
  isImageTurn: boolean;
  /** Threaded down so an approval card knows which chat to answer against. */
  chatId?: string | null;
  /** Present only while question cards are answerable (last message, idle). */
  onQuestionSubmit?: (prompt: string) => void;
}

/** The one turn kind with nothing to put on a timeline until it has finished. */
function GeneratingImagePlaceholder() {
  const { t } = useI18n();
  return (
    <div className="flex max-w-2xl flex-col gap-2 pl-4">
      <span className="animate-pulse text-sm font-medium text-on-surface">
        {t.chat.feed.generatingImage}
      </span>
      <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-container-highest">
        <div className="h-full w-1/2 animate-[slide_1s_ease-in-out_infinite_alternate] bg-primary" />
      </div>
    </div>
  );
}

/** Says a settled turn ended with nothing to show, rather than showing nothing. */
function NoResponseNotice() {
  const { t } = useI18n();
  return (
    <div className="max-w-2xl pl-4 font-body text-sm leading-relaxed">
      <span className="italic text-on-surface-variant/50">{t.chat.feed.noResponse}</span>
    </div>
  );
}

/** Whether the turn left behind anything a reader would call a response. */
function producedSomething(parts: readonly MessagePart[]): boolean {
  return parts.some((part) => part.type === 'text' || part.type === 'tool_call');
}

/**
 * Renders one assistant turn's body, streaming or settled, on one code path.
 *
 * A turn that has produced no parts yet is not a special case: `deriveTurnStatus`
 * calls it `working` and the timeline says so, which is why the whole window
 * before the first token now has a single presentation instead of a shimmer
 * that swapped for a timeline row partway through. The two remaining
 * placeholders are the ones the timeline genuinely cannot draw: an image turn
 * mid-generation, and a settled turn that produced neither text nor tool calls.
 *
 * Usage: <AssistantTurnBody parts={parts} status={status} messageId={msg.id} isStreaming />
 */
export function AssistantTurnBody({
  parts,
  status,
  messageId,
  isStreaming,
  isImageTurn,
  chatId = null,
  onQuestionSubmit,
}: AssistantTurnBodyProps) {
  if (isStreaming && isImageTurn) return <GeneratingImagePlaceholder />;

  return (
    <>
      <MessageParts
        parts={parts}
        messageId={messageId}
        chatId={chatId}
        isStreaming={isStreaming}
        onQuestionSubmit={onQuestionSubmit}
      />
      {status.phase === 'settled' && !producedSomething(parts) ? <NoResponseNotice /> : null}
    </>
  );
}
