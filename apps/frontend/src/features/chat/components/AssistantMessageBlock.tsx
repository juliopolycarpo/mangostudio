import type { Message, MessagePart } from '@mangostudio/shared';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import { Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { deriveTurnStatus, type TurnStatus } from '../lib/turn-status';
import { AssistantImageTurn } from './AssistantImageTurn';
import { AssistantMessageHeader } from './AssistantMessageHeader';
import { AssistantTurnBody } from './AssistantTurnBody';
import { messagePartsFromMessage } from './message-content';

interface AssistantMessageBlockProps {
  msg: Message;
  isImageTurn: boolean;
  chatId?: string | null;
  /** Present when this turn has a revertable manifest; absent means no affordance. */
  fileCheckpoint?: ChatFileCheckpointSummary;
  /** Present only on the last message while question cards may be answered. */
  onQuestionSubmit?: (prompt: string) => void;
}

/** What the block derives once and every child below it reads. */
interface DerivedTurn {
  parts: MessagePart[];
  status: TurnStatus;
  isStreaming: boolean;
}

/**
 * The turn's own cost, closing it out below the last step rather than above the
 * first one — it is not knowable until the turn is over.
 */
function TurnCostRow({ generationTime }: { generationTime: string }) {
  const { t } = useI18n();
  return (
    <div className="flex w-fit items-center gap-1.5 pl-4 text-[11px] text-on-surface-variant/50">
      <Sparkles size={11} className="text-primary/60" />
      <span>{formatMessage(t.chat.feed.respondedIn, { time: generationTime })}</span>
    </div>
  );
}

/** Routes an assistant turn to the body its generation state calls for. */
function AssistantTurnSection({
  msg,
  parts,
  status,
  isStreaming,
  isImageTurn,
  chatId,
  onQuestionSubmit,
}: AssistantMessageBlockProps & DerivedTurn) {
  // A settled image turn is its picture plus the controls that act on it, none
  // of which belong on a timeline.
  if (isImageTurn && !isStreaming) return <AssistantImageTurn msg={msg} />;

  return (
    <div className={isStreaming ? 'flex flex-col gap-3' : 'flex flex-col gap-1'}>
      <AssistantTurnBody
        parts={parts}
        status={status}
        messageId={msg.id}
        isStreaming={isStreaming}
        isImageTurn={isImageTurn}
        chatId={chatId}
        onQuestionSubmit={onQuestionSubmit}
      />
      {!isStreaming && msg.generationTime ? (
        <TurnCostRow generationTime={msg.generationTime} />
      ) : null}
    </div>
  );
}

/**
 * Renders a full assistant turn: the status header and the matching body
 * (live timeline, legacy image result, or settled text).
 *
 * The parts and their derived status are computed here, once per row, so every
 * child under this wrapper reads one answer rather than recomputing its own.
 *
 * Usage: <AssistantMessageBlock msg={msg} isImageTurn={isImageTurn} />
 */
export function AssistantMessageBlock(props: AssistantMessageBlockProps) {
  const { msg, isImageTurn, chatId, fileCheckpoint } = props;
  const parts = useMemo(() => messagePartsFromMessage(msg), [msg]);
  const isStreaming = msg.isGenerating ?? false;
  const status = useMemo(() => deriveTurnStatus(parts, isStreaming), [parts, isStreaming]);

  return (
    <div className="group flex w-full flex-col gap-2">
      <AssistantMessageHeader
        msg={msg}
        isImageTurn={isImageTurn}
        chatId={chatId}
        fileCheckpoint={fileCheckpoint}
      />
      <AssistantTurnSection {...props} parts={parts} status={status} isStreaming={isStreaming} />
    </div>
  );
}
