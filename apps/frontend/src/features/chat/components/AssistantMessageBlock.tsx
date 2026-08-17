import type { Message } from '@mangostudio/shared';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
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
      <div className="flex flex-col gap-3 py-4 pl-9">
        <StreamingMessageBody msg={msg} chatId={chatId} isImageTurn={isImageTurn} />
      </div>
    );
  }

  if (isImageTurn) {
    return <AssistantImageTurn msg={msg} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {msg.generationTime && (
        <div className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-lowest py-2 px-3 rounded-lg w-fit border border-outline-variant/10">
          <Sparkles size={12} className="text-primary" />
          <span>{t.chat.feed.respondedIn.replace('{time}', msg.generationTime)}</span>
        </div>
      )}
      <CompletedMessageBody msg={msg} chatId={chatId} onQuestionSubmit={onQuestionSubmit} />
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
    <div className="group flex flex-col gap-4 w-full">
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
