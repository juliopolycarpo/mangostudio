import type { Message } from '@mangostudio/shared/chat';
import type { ChatFileCheckpointSummary } from '@mangostudio/shared/file-checkpoints';
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import type { MessagePart } from '@mangostudio/shared/types';
import { TOOL_AVATAR_SIZE_CLASS, ToolAvatar } from '@/components/ui/ToolAvatar';
import type { ToolIdentityResolver } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { MANGO_IDENTITY } from '@/lib/agent-identity';
import { formatClockTime } from '@/lib/i18n-format';
import { cn } from '@/lib/utils';
import { agentRunnerName, deriveTurnIdentity } from '../lib/turn-identity';
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
  /** Resolved once per feed by `ChatFeed`, not once per row. */
  toolIdentities: ToolIdentityResolver;
  /** Catalog names by model id, resolved once per feed; an id it lacks is shown as stored. */
  modelNames?: ReadonlyMap<string, string>;
}

/**
 * A model's monogram, in MangoStudio's own hue on a neutral fill.
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
      className={cn(
        'flex shrink-0 items-center justify-center bg-fill-selected font-semibold',
        TOOL_AVATAR_SIZE_CLASS.xs
      )}
      style={{ color: MANGO_IDENTITY.colorVar }}
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
 * The rule runs the whole width of the column. The actions sit on top of its
 * right end instead of in the row, so showing or hiding them reflows nothing:
 * with the copy and revert buttons in flow, they held their width at
 * `opacity: 0` and the rule stopped 86px short of the event rules below it.
 *
 * Usage: <TurnSeparator msg={msg} parts={parts} status={status} isImageTurn={false} toolIdentities={identities} />
 */
export function TurnSeparator({
  msg,
  parts,
  status,
  isImageTurn,
  chatId,
  fileCheckpoint,
  toolIdentities,
  modelNames,
}: TurnSeparatorProps) {
  const { t, locale } = useI18n();
  const { resolve } = toolIdentities;
  const identity = deriveTurnIdentity(
    msg,
    parts,
    t.externalAgents.target,
    t.chat.feed.modelFallback,
    modelNames
  );
  // `agent:<targetId>` is a real identity subject with storage, an edit dialog
  // and an avatar palette, so renaming Codex in Environments renames it here for
  // free — and the same resolver feeds both the name and the avatar, so they
  // cannot disagree.
  const agent = identity.kind === 'agent' ? resolve('agent', identity.targetId) : null;
  const name =
    identity.kind === 'agent'
      ? agent
        ? agentRunnerName(agent, identity.targetId, t.externalAgents.target)
        : ''
      : identity.name;
  // `msg.isGenerating` is only *this session* receiving tokens — a vendor turn
  // reopened mid-flight reads false on reload even though `deriveTurnStatus`
  // still reports `working` from the turn record. The derived phase is what
  // actually knows the vendor is still writing, so actions gate on it instead.
  const turnIsSettledEnoughForActions =
    status.phase === 'settled' || status.phase === 'awaiting-user';
  // An image turn has no markdown to copy and no checkpoint to revert, and a
  // turn still running has nothing settled enough to act on.
  const showTurnActions = turnIsSettledEnoughForActions && !isImageTurn;

  // A name that is the stored id itself — the catalog no longer lists the model —
  // is technical content, so it is drawn as such rather than in the interface font.
  const nameIsRawId =
    identity.kind === 'model' && identity.modelId !== null && identity.name === identity.modelId;

  return (
    <div className="relative flex items-center gap-2">
      {/* Who is answering. Capped while the actions are on screen, so a long
          name truncates instead of running under them. */}
      <div
        className={cn(
          'flex min-w-0 items-center gap-2',
          turnIsSettledEnoughForActions && 'max-w-[calc(100%-10rem)]'
        )}
      >
        {identity.kind === 'agent' && agent ? (
          <ToolAvatar
            subjectKey={toolSubjectKey('agent', identity.targetId)}
            monogram={agent.monogram}
            name={name}
            image={agent.image}
            size="xs"
            className="shrink-0"
          />
        ) : (
          <ModelMonogram monogram={identity.kind === 'model' ? identity.monogram : ''} />
        )}
        <span
          title={identity.kind === 'model' ? (identity.modelId ?? undefined) : undefined}
          className={cn(
            'min-w-0 truncate text-xs font-medium text-fg-muted',
            nameIsRawId && 'font-mono text-micro text-fg-subtle'
          )}
        >
          {name}
        </span>
        {/* The chip yields to the working row, but an image turn never draws one:
            `AssistantTurnBody` swaps the whole timeline for the generating
            placeholder, so deferring to it here would leave the separator silent
            for the one turn kind that has nothing else to say. */}
        <TurnStatusChip
          phase={status.phase}
          showWorkingRow={status.showWorkingRow && !isImageTurn}
        />
      </div>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-stroke" />
      {turnIsSettledEnoughForActions && (
        <div className="absolute right-0 flex items-center">
          {/* The buttons reveal themselves; this backdrop is opaque only when
              they are, so at rest the rule runs on behind them. Not an opacity
              on the wrapper: the revert confirmation is a child of it. */}
          {showTurnActions && (
            <div className="flex items-center gap-1 bg-transparent pl-2 transition-colors group-focus-within:bg-canvas group-hover:bg-canvas pointer-coarse:bg-canvas">
              <CopyMessageButton
                msg={msg}
                label={t.chat.copyMessage}
                copiedLabel={t.chat.messageCopied}
              />
              {chatId && fileCheckpoint && (
                <RevertFileChangesButton
                  chatId={chatId}
                  messageId={msg.id}
                  uncheckpointedSources={fileCheckpoint.uncheckpointedSources}
                />
              )}
            </div>
          )}
          {/* Always on screen, like a user bubble's: the same fact should not be
              there on one side of the conversation and hover-only on the other. */}
          <span className="shrink-0 bg-canvas pl-2 font-mono text-micro text-fg-subtle">
            {formatClockTime(msg.timestamp, locale)}
          </span>
        </div>
      )}
    </div>
  );
}
