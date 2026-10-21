import type { Message } from '@mangostudio/shared/chat';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import type { MessagePart } from '@mangostudio/shared/types';
import { Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import type { ToolIdentityResolver } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { deriveTurnStatus, type TurnStatus } from '../lib/turn-status';
import { AssistantImageTurn } from './AssistantImageTurn';
import { AssistantTurnBody } from './AssistantTurnBody';
import { messagePartsFromMessage } from './message-content';
import { TurnSeparator } from './TurnSeparator';

interface AssistantMessageBlockProps {
  msg: Message;
  isImageTurn: boolean;
  chatId?: string | null;
  /** Present when this turn has a revertable manifest; absent means no affordance. */
  fileCheckpoint?: ChatFileCheckpointSummary;
  /** Present only on the last message while question cards may be answered. */
  onQuestionSubmit?: (prompt: string) => void;
  /** Resolved once per feed by `ChatFeed`, threaded down to every row. */
  toolIdentities: ToolIdentityResolver;
  /** Catalog names by model id, resolved once per feed and read by the turn header. */
  modelNames?: ReadonlyMap<string, string>;
}

/** What the block derives once and every child below it reads. */
interface DerivedTurn {
  parts: MessagePart[];
  status: TurnStatus;
  isStreaming: boolean;
}

/** How a turn ended, as far as its own parts can say. */
type TurnOutcome = 'completed' | 'failed' | 'stopped';

/**
 * A turn that carries an error part failed; one with an interrupted checkpoint
 * was stopped partway. Anything else is a turn that finished.
 */
function turnOutcome(parts: readonly MessagePart[]): TurnOutcome {
  if (parts.some((part) => part.type === 'error')) return 'failed';
  if (parts.some((part) => part.type === 'turn_checkpoint' && part.status === 'interrupted')) {
    return 'stopped';
  }
  return 'completed';
}

/**
 * The turn's own cost, closing it out below the last step rather than above the
 * first one — it is not knowable until the turn is over.
 *
 * It says how the turn ended as well as how long it took: "Responded in 12.8s"
 * under a rate-limit error told the reader the turn above had succeeded.
 */
function TurnCostRow({
  generationTime,
  outcome,
}: {
  generationTime: string;
  outcome: TurnOutcome;
}) {
  const { t } = useI18n();
  const message = {
    completed: t.chat.feed.respondedIn,
    failed: t.chat.feed.failedAfter,
    stopped: t.chat.feed.stoppedAfter,
  }[outcome];
  return (
    <div className="flex w-fit items-center gap-1.5 pl-4 font-mono text-micro text-fg-subtle">
      <Sparkles size={ICON_SM} />
      <span>{formatMessage(message, { time: generationTime })}</span>
    </div>
  );
}

interface AssistantTurnSectionProps extends DerivedTurn {
  msg: Message;
  isImageTurn: boolean;
  chatId?: string | null;
  onQuestionSubmit?: (prompt: string) => void;
  toolIdentities: ToolIdentityResolver;
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
  toolIdentities,
}: AssistantTurnSectionProps) {
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
        toolIdentities={toolIdentities}
      />
      {!isStreaming && msg.generationTime ? (
        <TurnCostRow generationTime={msg.generationTime} outcome={turnOutcome(parts)} />
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
 * Usage: <AssistantMessageBlock msg={msg} isImageTurn={isImageTurn} toolIdentities={identities} />
 */
export function AssistantMessageBlock({
  msg,
  isImageTurn,
  chatId,
  fileCheckpoint,
  onQuestionSubmit,
  toolIdentities,
  modelNames,
}: AssistantMessageBlockProps) {
  const parts = useMemo(() => messagePartsFromMessage(msg), [msg]);
  const isStreaming = msg.isGenerating ?? false;
  const status = useMemo(() => deriveTurnStatus(parts, isStreaming), [parts, isStreaming]);

  return (
    <div className="group flex w-full flex-col gap-2">
      <TurnSeparator
        msg={msg}
        parts={parts}
        status={status}
        isImageTurn={isImageTurn}
        chatId={chatId}
        fileCheckpoint={fileCheckpoint}
        toolIdentities={toolIdentities}
        modelNames={modelNames}
      />
      <AssistantTurnSection
        msg={msg}
        parts={parts}
        status={status}
        isStreaming={isStreaming}
        isImageTurn={isImageTurn}
        chatId={chatId}
        onQuestionSubmit={onQuestionSubmit}
        toolIdentities={toolIdentities}
      />
    </div>
  );
}
