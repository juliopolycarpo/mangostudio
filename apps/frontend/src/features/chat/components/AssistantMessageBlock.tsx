import type { Message } from '@mangostudio/shared';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { AssistantImageTurn } from './AssistantImageTurn';
import { CompletedMessageBody, StreamingMessageBody } from './AssistantMessageBody';
import { AssistantMessageHeader } from './AssistantMessageHeader';

interface AssistantMessageBlockProps {
  msg: Message;
  isImageTurn: boolean;
  chatId?: string | null;
  /** Present when this turn has a revertable manifest; absent means no affordance. */
  fileCheckpoint?: ChatFileCheckpointSummary;
  /** Present only on the last message while question cards may be answered. */
  onQuestionSubmit?: (prompt: string) => void;
}

/** Renders the body for an assistant turn based on its generation state. */
function AssistantMessageBody({
  msg,
  isImageTurn,
  chatId,
  onQuestionSubmit,
}: AssistantMessageBlockProps) {
  const { t } = useI18n();

  if (msg.isGenerating) {
    return (
      <div className="flex flex-col gap-3">
        <StreamingMessageBody msg={msg} chatId={chatId} isImageTurn={isImageTurn} />
      </div>
    );
  }

  if (isImageTurn) {
    return <AssistantImageTurn msg={msg} />;
  }

  return (
    <div className="flex flex-col gap-1">
      <CompletedMessageBody msg={msg} chatId={chatId} onQuestionSubmit={onQuestionSubmit} />
      {/* The turn's own cost closes it out, below the last step rather than
          above the first one — it is not knowable until the turn is over. */}
      {msg.generationTime && (
        <div className="flex w-fit items-center gap-1.5 pl-4 text-[11px] text-on-surface-variant/50">
          <Sparkles size={11} className="text-primary/60" />
          <span>{formatMessage(t.chat.feed.respondedIn, { time: msg.generationTime })}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Renders a full assistant turn: the status header and the matching body
 * (streaming skeleton, legacy image result, or completed text).
 *
 * Usage: <AssistantMessageBlock msg={msg} isImageTurn={isImageTurn} />
 */
export function AssistantMessageBlock({
  msg,
  isImageTurn,
  chatId,
  fileCheckpoint,
  onQuestionSubmit,
}: AssistantMessageBlockProps) {
  return (
    <div className="group flex w-full flex-col gap-2">
      <AssistantMessageHeader
        msg={msg}
        isImageTurn={isImageTurn}
        chatId={chatId}
        fileCheckpoint={fileCheckpoint}
      />
      <AssistantMessageBody
        msg={msg}
        isImageTurn={isImageTurn}
        chatId={chatId}
        onQuestionSubmit={onQuestionSubmit}
      />
    </div>
  );
}
