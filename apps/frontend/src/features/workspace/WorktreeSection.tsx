import type { GitWorktree } from '@mangostudio/shared/git';
import type { Messages } from '@mangostudio/shared/i18n';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { useToast } from '@/components/ui/Toast';
import { gitMessages } from '@/features/workspace/git-i18n';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { workdirLabel } from '@/lib/paths';
import { resolveApiErrorMessage } from '@/lib/utils';

import { GroupHeading } from './components/GroupHeading';
import { IconButton } from './components/IconButton';
import { RowList } from './components/RowList';
import {
  type AddWorktreeInput,
  useAddWorktree,
  useGitWorktrees,
  useRemoveWorktree,
} from './hooks/use-git-state';
import { shortHash } from './short-hash';
import { WorktreeAddForm } from './WorktreeAddForm';

type WorktreeLabels = Messages['git']['worktrees'];

/**
 * The repository's worktrees, listed under the Git panel's branch and change
 * groups.
 *
 * The row the chat is working in is the one the server flags `isCurrent`; it is
 * marked and kept out of reach of the remove button. A row another chat works
 * in is flagged `boundByOtherChat`; it is marked, and its remove button is
 * disabled with the reason. The client does not compare paths itself, since the
 * server's comparison honours the runtime's separators, symlinks and casing and
 * a string match here would not.
 *
 * @example
 * <WorktreeSection chatId={chatId} />
 */
export function WorktreeSection({ chatId }: { readonly chatId: string }) {
  const { t } = useI18n(gitMessages);
  const { toast } = useToast();
  const labels = t.git.worktrees;
  const worktreesQuery = useGitWorktrees(chatId);
  const addMutation = useAddWorktree(chatId);
  const removeMutation = useRemoveWorktree(chatId);
  const [formOpen, setFormOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<GitWorktree | null>(null);
  const [force, setForce] = useState(false);

  const add = async (input: AddWorktreeInput) => {
    try {
      await addMutation.mutateAsync(input);
      setFormOpen(false);
      toast(labels.added.replace('{path}', input.path), 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await removeMutation.mutateAsync({ path: removeTarget.path, force });
      setRemoveTarget(null);
      setForce(false);
      toast(labels.removed, 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const worktrees = worktreesQuery.data?.worktrees ?? [];

  return (
    <section>
      {/* The count only earns its badge once there is something to count: a lone
          main worktree is every repository, and a "1" beside the title is noise.
          The panel header's refresh also refetches this list. */}
      <GroupHeading
        title={labels.title}
        count={worktrees.length > 1 ? worktrees.length : undefined}
      >
        <IconButton
          label={labels.add}
          disabled={addMutation.isPending}
          onClick={() => setFormOpen((open) => !open)}
        >
          <Plus size={ICON_SM} />
        </IconButton>
      </GroupHeading>

      {formOpen ? (
        <div className="mb-3">
          <WorktreeAddForm
            pending={addMutation.isPending}
            onSubmit={(input) => void add(input)}
            onCancel={() => setFormOpen(false)}
          />
        </div>
      ) : null}

      <WorktreeList
        worktrees={worktrees}
        loading={worktreesQuery.isLoading}
        error={worktreesQuery.error}
        pending={removeMutation.isPending}
        onRetry={() => void worktreesQuery.refetch()}
        onRemove={(worktree) => {
          setForce(false);
          setRemoveTarget(worktree);
        }}
      />

      {removeTarget ? (
        <ConfirmDialog
          title={labels.removeTitle}
          description={labels.removeHint}
          entityName={removeTarget.path}
          confirmLabel={labels.removeConfirm}
          cancelLabel={labels.removeCancel}
          isPending={removeMutation.isPending}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoveTarget(null)}
        >
          <label className="flex cursor-pointer items-center gap-2 pt-2 text-sm text-fg">
            <Checkbox checked={force} onChange={(event) => setForce(event.target.checked)} />
            {labels.force}
          </label>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function WorktreeList({
  worktrees,
  loading,
  error,
  pending,
  onRetry,
  onRemove,
}: {
  readonly worktrees: readonly GitWorktree[];
  readonly loading: boolean;
  readonly error: Error | null;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onRemove: (worktree: GitWorktree) => void;
}) {
  const { t } = useI18n(gitMessages);
  const labels = t.git.worktrees;

  if (error) {
    return (
      <Callout
        tone="danger"
        title={labels.loadError}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  if (loading) {
    return <EmptyState icon={<Spinner />} title={labels.loading} className="min-h-24 py-4" />;
  }
  // A repository always has a main worktree, so a single row is a standing fact
  // and not an empty list. One quiet line: an `EmptyState` title is 14px in
  // `fg` and outshouts the section's own micro-label.
  if (worktrees.length <= 1) return <p className="text-xs text-fg-muted">{labels.empty}</p>;

  return (
    <RowList>
      {worktrees.map((worktree) => (
        <WorktreeRow
          key={worktree.path}
          worktree={worktree}
          isCurrent={worktree.isCurrent}
          pending={pending}
          onRemove={() => onRemove(worktree)}
        />
      ))}
    </RowList>
  );
}

function WorktreeRow({
  worktree,
  isCurrent,
  pending,
  onRemove,
}: {
  readonly worktree: GitWorktree;
  readonly isCurrent: boolean;
  readonly pending: boolean;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n(gitMessages);
  const labels = t.git.worktrees;
  const removable = !worktree.isMain && !isCurrent;
  const removeLabel = labels.removeLabel.replace('{path}', worktree.path);
  // Why the button is offered but cannot be pressed. Both reasons are ones the
  // server also refuses with a 409, so the panel states them up front.
  const blockedReason = worktree.isLocked
    ? lockTitle(worktree, labels)
    : worktree.boundByOtherChat
      ? labels.otherChatReason
      : undefined;

  return (
    <li className="flex min-w-0 items-start gap-2 px-3 py-2">
      <StatusDot tone={rowTone(worktree, isCurrent)} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-fg"
          title={labels.open.replace('{path}', worktree.path)}
        >
          {workdirLabel(worktree.path) ?? worktree.path}
        </p>
        <p className="truncate font-mono text-xs text-fg-muted">
          {worktree.branch ??
            labels.detached.replace('{commit}', worktree.head ? shortHash(worktree.head) : '')}
        </p>
        <WorktreeBadges worktree={worktree} isCurrent={isCurrent} labels={labels} />
      </div>
      {removable ? (
        <IconButton
          label={removeLabel}
          tone="danger"
          disabled={pending || blockedReason !== undefined}
          onClick={onRemove}
          // The tooltip carries the reason while the button is unavailable.
          title={blockedReason}
        >
          <Trash2 size={ICON_SM} />
        </IconButton>
      ) : null}
    </li>
  );
}

function WorktreeBadges({
  worktree,
  isCurrent,
  labels,
}: {
  readonly worktree: GitWorktree;
  readonly isCurrent: boolean;
  readonly labels: WorktreeLabels;
}) {
  const badges: Array<{ key: string; text: string; variant: 'accent' | 'neutral' | 'warning' }> =
    [];
  if (isCurrent) badges.push({ key: 'current', text: labels.badges.current, variant: 'accent' });
  if (worktree.isMain) badges.push({ key: 'main', text: labels.badges.main, variant: 'neutral' });
  if (worktree.boundByOtherChat) {
    badges.push({ key: 'otherChat', text: labels.badges.otherChat, variant: 'neutral' });
  }
  if (worktree.isDetached) {
    badges.push({ key: 'detached', text: labels.badges.detached, variant: 'neutral' });
  }
  if (worktree.isLocked) {
    badges.push({ key: 'locked', text: labels.badges.locked, variant: 'warning' });
  }
  if (worktree.isPrunable) {
    badges.push({ key: 'prunable', text: labels.badges.prunable, variant: 'warning' });
  }
  if (badges.length === 0) return null;

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {badges.map((badge) => (
        <Badge
          key={badge.key}
          variant={badge.variant}
          title={badgeTitle(badge.key, worktree, labels)}
        >
          {badge.text}
        </Badge>
      ))}
    </span>
  );
}

/** The reason Git recorded, shown where the state it explains is displayed. */
function badgeTitle(
  key: string,
  worktree: GitWorktree,
  labels: WorktreeLabels
): string | undefined {
  if (key === 'locked') return lockTitle(worktree, labels);
  if (key === 'otherChat') return labels.otherChatReason;
  if (key === 'prunable' && worktree.prunableReason) {
    return labels.prunableReason.replace('{reason}', worktree.prunableReason);
  }
  return undefined;
}

function lockTitle(worktree: GitWorktree, labels: WorktreeLabels): string {
  return worktree.lockReason
    ? labels.lockedReason.replace('{reason}', worktree.lockReason)
    : labels.badges.locked;
}

/** Attention first: a worktree that needs a decision outranks the one in use. */
function rowTone(worktree: GitWorktree, isCurrent: boolean): StatusDotTone {
  if (worktree.isPrunable || worktree.isLocked) return 'warning';
  if (isCurrent) return 'accent';
  return 'neutral';
}
