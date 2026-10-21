import type { Message } from '@mangostudio/shared/chat';
import type { ExternalTurnTerminalReason } from '@mangostudio/shared/external-agents';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import type { MessagePart } from '@mangostudio/shared/types';
import { CircleStop, CircleX, type LucideIcon, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import type { ToolIdentityResolver } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { deriveTurnStatus, type TurnStatus } from '../lib/turn-status';
import { AssistantImageTurn } from './AssistantImageTurn';
import { AssistantTurnBody } from './AssistantTurnBody';
import { messagePartsFromMessage } from './message-content';
import { TurnMetaRow } from './TurnMetaRow';
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

const OUTCOME_ICON: Record<TurnOutcome, LucideIcon> = {
  completed: Sparkles,
  failed: CircleX,
  stopped: CircleStop,
};

/**
 * How an external agent's turn ended, on the same three-way scale. Only the
 * vendor's own failure is a failure; everything else that cut the turn short —
 * the person, the vendor, the connection, the hub — stopped it.
 *
 * Exhaustive on purpose: a reason added to the contract fails the build here.
 */
const EXTERNAL_OUTCOME: Record<ExternalTurnTerminalReason, TurnOutcome> = {
  completed: 'completed',
  'cancelled-by-user': 'stopped',
  interrupted: 'stopped',
  'vendor-error': 'failed',
  'runtime-disconnected': 'stopped',
  'hub-restarted': 'stopped',
  'sequence-gap': 'stopped',
  'limit-exceeded': 'stopped',
  'consent-revoked': 'stopped',
  'session-lost': 'stopped',
  'acceptance-unknown': 'stopped',
};

/** The reason an external turn ended, once it has; absent for any other turn. */
function externalTerminalReason(
  parts: readonly MessagePart[]
): ExternalTurnTerminalReason | undefined {
  const turn = parts.find((part) => part.type === 'external_turn');
  return turn?.type === 'external_turn' && turn.status === 'terminal'
    ? turn.terminalReason
    : undefined;
}

/**
 * A turn that carries an error part failed; one with an interrupted checkpoint
 * was stopped partway; an external turn ends the way its record says. A legacy
 * image turn with words and no picture is the failure its words describe.
 * Anything else is a turn that finished.
 */
function turnOutcome(
  msg: Message,
  parts: readonly MessagePart[],
  isImageTurn: boolean
): TurnOutcome {
  if (parts.some((part) => part.type === 'error')) return 'failed';
  if (parts.some((part) => part.type === 'turn_checkpoint' && part.status === 'interrupted')) {
    return 'stopped';
  }
  const external = externalTerminalReason(parts);
  if (external) return EXTERNAL_OUTCOME[external];
  if (isImageTurn && !msg.imageUrl && msg.text) return 'failed';
  return 'completed';
}

/**
 * The line that closes a settled turn, below its last step rather than above the
 * first one — none of it is knowable until the turn is over.
 *
 * It says how the turn ended as well as how long it took: "Responded in 12.8s"
 * under a rate-limit error told the reader the turn above had succeeded. An
 * external turn the hub or the person cut short says why in the same row ("You
 * stopped this turn."), with the time after it, so the ending is told once.
 */
function TurnClosingRow({
  msg,
  parts,
  isImageTurn,
}: {
  msg: Message;
  parts: readonly MessagePart[];
  isImageTurn: boolean;
}) {
  const { t } = useI18n();
  const outcome = turnOutcome(msg, parts, isImageTurn);
  const reason = externalTerminalReason(parts);
  const cause = reason && reason !== 'completed' ? t.externalAgents.turn.terminal[reason] : null;
  const time = msg.generationTime;
  if (!cause && !time) return null;

  const icon = OUTCOME_ICON[outcome];
  if (cause) {
    return (
      <TurnMetaRow icon={icon}>
        <span>{cause}</span>
        {time ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">{time}</span>
          </>
        ) : null}
      </TurnMetaRow>
    );
  }
  const message = {
    completed: t.chat.feed.respondedIn,
    failed: t.chat.feed.failedAfter,
    stopped: t.chat.feed.stoppedAfter,
  }[outcome];
  return (
    <TurnMetaRow icon={icon}>
      <span>{formatMessage(message, { time: time ?? '' })}</span>
    </TurnMetaRow>
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
  return (
    <div className={isStreaming ? 'flex flex-col gap-3' : 'flex flex-col gap-1'}>
      {/* A settled image turn is its picture plus the controls that act on it,
          none of which belong on a timeline; it still closes on the same line. */}
      {isImageTurn && !isStreaming ? (
        <AssistantImageTurn msg={msg} />
      ) : (
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
      )}
      {isStreaming ? null : <TurnClosingRow msg={msg} parts={parts} isImageTurn={isImageTurn} />}
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
