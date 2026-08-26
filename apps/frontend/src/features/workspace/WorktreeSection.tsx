import type { GitWorktree } from '@mangostudio/shared/git';
import type { Messages } from '@mangostudio/shared/i18n';
import { AlertTriangle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { workdirLabel } from '@/lib/paths';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  type AddWorktreeInput,
  useAddWorktree,
  useGitWorktrees,
  useRemoveWorktree,
} from './hooks/use-git-state';
import { WorktreeAddForm } from './WorktreeAddForm';

type WorktreeLabels = Messages['git']['worktrees'];

/**
 * The repository's worktrees, listed under the Git panel's branch and change
 * groups.
 *
 * `repoRoot` is what the calling chat resolved to, which is how the row the
 * chat is working in is marked and kept out of reach of the remove button.
 *
 * @example
 * <WorktreeSection chatId={chatId} repoRoot={state.root} />
 */
export function WorktreeSection({
  chatId,
  repoRoot,
}: {
  readonly chatId: string;
  readonly repoRoot: string;
}) {
  const { t } = useI18n();
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
      <MicroLabel as="h3" className="mb-1.5 flex items-center gap-2 font-bold tracking-[0.12em]">
        <span>{labels.title}</span>
        {worktrees.length > 0 ? (
          <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 font-mono text-[9px] tracking-normal">
            {worktrees.length}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <IconAction
            label={labels.refresh}
            disabled={worktreesQuery.isFetching}
            onClick={() => void worktreesQuery.refetch()}
          >
            <RefreshCw
              size={ICON_SM}
              className={worktreesQuery.isFetching ? 'animate-spin' : undefined}
            />
          </IconAction>
          <IconAction
            label={labels.add}
            disabled={addMutation.isPending}
            onClick={() => setFormOpen((open) => !open)}
          >
            <Plus size={ICON_SM} />
          </IconAction>
        </span>
      </MicroLabel>

      {formOpen ? (
        <WorktreeAddForm
          pending={addMutation.isPending}
          onSubmit={(input) => void add(input)}
          onCancel={() => setFormOpen(false)}
        />
      ) : null}

      <WorktreeList
        worktrees={worktrees}
        repoRoot={repoRoot}
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
          <label className="flex cursor-pointer items-center gap-2 text-xs text-on-surface-variant">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
              className="accent-primary"
            />
            {labels.force}
          </label>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function WorktreeList({
  worktrees,
  repoRoot,
  loading,
  error,
  pending,
  onRetry,
  onRemove,
}: {
  readonly worktrees: readonly GitWorktree[];
  readonly repoRoot: string;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onRemove: (worktree: GitWorktree) => void;
}) {
  const { t } = useI18n();
  const labels = t.git.worktrees;

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={ICON_SM} />}
        title={labels.loadError}
        tone="error"
        action={
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  if (loading) {
    return (
      <EmptyState
        icon={<RefreshCw size={ICON_SM} className="animate-spin" />}
        title={labels.loading}
      />
    );
  }
  // A repository always has a main worktree, so a single row means there is
  // nothing here the panel did not already say at the top.
  if (worktrees.length <= 1) return <EmptyState title={labels.empty} />;

  return (
    <ul className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40">
      {worktrees.map((worktree) => (
        <WorktreeRow
          key={worktree.path}
          worktree={worktree}
          isCurrent={worktree.path === repoRoot}
          pending={pending}
          onRemove={() => onRemove(worktree)}
        />
      ))}
    </ul>
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
  const { t } = useI18n();
  const labels = t.git.worktrees;
  const removable = !worktree.isMain && !isCurrent;
  const removeLabel = labels.removeLabel.replace('{path}', worktree.path);

  return (
    <li className="flex min-w-0 items-start gap-2 border-b border-outline-variant/10 px-2.5 py-2 last:border-b-0">
      <StatusDot tone={rowTone(worktree, isCurrent)} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-[11px] font-semibold leading-4 text-on-surface"
          title={labels.open.replace('{path}', worktree.path)}
        >
          {workdirLabel(worktree.path) ?? worktree.path}
        </p>
        <p className="truncate font-mono text-[10px] text-on-surface-variant">
          {worktree.branch ?? labels.detached.replace('{commit}', worktree.head?.slice(0, 8) ?? '')}
        </p>
        <WorktreeBadges worktree={worktree} isCurrent={isCurrent} labels={labels} />
      </div>
      {removable ? (
        <button
          type="button"
          aria-label={removeLabel}
          title={worktree.isLocked ? lockTitle(worktree, labels) : removeLabel}
          disabled={pending || worktree.isLocked}
          onClick={onRemove}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-on-surface-variant transition-colors hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Trash2 size={ICON_SM} />
        </button>
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
          className="px-1.5 py-0.5 text-[9px] tracking-normal"
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

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded tracking-normal text-on-surface-variant transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-wait disabled:opacity-50"
    >
      {children}
    </button>
  );
}
