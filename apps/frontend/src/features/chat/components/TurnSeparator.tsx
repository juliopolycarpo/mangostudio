import type { Message, MessagePart } from '@mangostudio/shared';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import { format } from 'date-fns';
import { TOOL_AVATAR_SIZE_CLASS, ToolAvatar } from '@/components/ui/ToolAvatar';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { MANGO_IDENTITY } from '@/lib/agent-identity';
import { deriveTurnIdentity } from '../lib/turn-identity';
import type { TurnStatus } from '../lib/turn-status';
import { CopyMessageButton } from './CopyMessageButton';
import { RevertFileChangesButton } from './RevertFileChangesButton';
import { TurnStatusChip } from './TurnStatusChip';

interface TurnSeparatorProps {
  msg: Message;
  parts: MessagePart[];
  status: TurnStatus;
  isImageTurn: boolean;
  chatId?: string | null;
  /** Present when this turn has a revertable manifest; absent means no affordance. */
  fileCheckpoint?: ChatFileCheckpointSummary;
}

/**
 * A model's monogram, tinted with MangoStudio's own hue.
 *
 * Not a `ToolAvatar`: that draws a *subject*, and the identity kinds are a
 * closed union with no `model` member. A `model:gpt-5` subject key would be a
 * key the API rejects and no user could ever edit, so the chip is drawn plainly
 * rather than pretending to an identity that has nowhere to live. It shares
 * `ToolAvatar`'s `xs` size class so the two chips — which sit in the same slot
 * of the same row, one per turn kind — line up.
 */
function ModelMonogram({ monogram }: { monogram: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center font-semibold ${TOOL_AVATAR_SIZE_CLASS.xs}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${MANGO_IDENTITY.colorVar} 18%, transparent)`,
        color: MANGO_IDENTITY.colorVar,
      }}
    >
      {monogram}
    </span>
  );
}

/**
 * Where one turn starts: a hairline rule carrying who is answering, what they
 * are doing, and the actions that operate on the turn as a whole.
 *
 * It replaces a banner that stamped `REPLIED WITH: CLAUDE CODE` over every
 * message. That restated the agent on every turn of a conversation where it
 * rarely changes, and its verb went stale the moment a turn was reloaded — a
 * turn interrupted mid-flight still read "Replied". Identity belongs on the
 * boundary; what the turn is *doing* is derived rather than stored, so it can
 * only be said while it is true.
 *
 * Usage: <TurnSeparator msg={msg} parts={parts} status={status} isImageTurn={false} />
 */
export function TurnSeparator({
  msg,
  parts,
  status,
  isImageTurn,
  chatId,
  fileCheckpoint,
}: TurnSeparatorProps) {
  const { t } = useI18n();
  const { resolve } = useToolIdentities();
  const identity = deriveTurnIdentity(
    msg,
    parts,
    t.externalAgents.target,
    t.chat.feed.modelFallback
  );
  // `agent:<targetId>` is a real identity subject with storage, an edit dialog
  // and an avatar palette, so renaming Codex in Environments renames it here for
  // free — and the same resolver feeds both the name and the avatar, so they
  // cannot disagree.
  const agent = identity.kind === 'agent' ? resolve('agent', identity.targetId) : null;
  const name = agent?.name ?? (identity.kind === 'model' ? identity.name : '');
  // An image turn has no markdown to copy and no checkpoint to revert, and a
  // turn still running has nothing settled enough to act on.
  const showTurnActions = !msg.isGenerating && !isImageTurn;

  return (
    <div className="flex items-center gap-2">
      {identity.kind === 'agent' && agent ? (
        <ToolAvatar
          subjectKey={toolSubjectKey('agent', identity.targetId)}
          monogram={agent.monogram}
          name={agent.name}
          image={agent.image}
          size="xs"
          className="shrink-0"
        />
      ) : (
        <ModelMonogram monogram={identity.kind === 'model' ? identity.monogram : ''} />
      )}
      <span className="shrink-0 text-[11px] text-on-surface-variant/70">{name}</span>
      <TurnStatusChip phase={status.phase} showWorkingRow={status.showWorkingRow} />
      {/* The rule takes the slack, so the actions stay pinned right however
          long the name is. */}
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-outline-variant/25" />
      {showTurnActions && (
        <CopyMessageButton
          msg={msg}
          label={t.chat.copyMessage}
          copiedLabel={t.chat.messageCopied}
        />
      )}
      {showTurnActions && chatId && fileCheckpoint && (
        <RevertFileChangesButton
          chatId={chatId}
          messageId={msg.id}
          uncheckpointedSources={fileCheckpoint.uncheckpointedSources}
        />
      )}
      {!msg.isGenerating && (
        <span className="shrink-0 font-label text-[10px] text-on-surface-variant/50 opacity-0 transition-opacity duration-(--duration-base) group-hover:opacity-100">
          {format(msg.timestamp, 'h:mm a')}
        </span>
      )}
    </div>
  );
}
