import type { GitBranchInfo } from '@mangostudio/shared/git';
import { Check, History, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { SplitButton } from '@/components/ui/SplitButton';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useCommit, useGitPull, useGitPush, useStagePaths } from './hooks/use-git-state';

export type CommitAction =
  | 'commit'
  | 'stage-all-and-commit'
  | 'commit-and-push'
  | 'commit-and-sync'
  | 'amend';

interface CommitActionsInput {
  readonly chatId: string;
  readonly title: string;
  readonly body: string;
  readonly amend: boolean;
  readonly onCommitted: () => void;
  readonly onEnterAmend: () => void;
  /** Surfaces a failed push to the shared remote guidance banner. */
  readonly onRemoteFailure: (error: unknown) => void;
}

export interface CommitActionsController {
  readonly run: (action: CommitAction) => Promise<void>;
  readonly pending: boolean;
}

/**
 * Chains the mutations behind each menu entry, stopping at the first failure
 * and naming the step that failed — a commit that landed before a push failed
 * must not be reported as a failed commit.
 */
export function useCommitActions({
  chatId,
  title,
  body,
  amend,
  onCommitted,
  onEnterAmend,
  onRemoteFailure,
}: CommitActionsInput): CommitActionsController {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.commitActions;
  const commitLabels = t.git.commit;
  const stageMutation = useStagePaths(chatId);
  const commitMutation = useCommit(chatId);
  const pullMutation = useGitPull(chatId);
  const pushMutation = useGitPush(chatId);

  const run = async (action: CommitAction) => {
    if (action === 'amend') {
      onEnterAmend();
      return;
    }

    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    if (action === 'stage-all-and-commit') {
      try {
        await stageMutation.mutateAsync({ all: true });
      } catch (error) {
        toast(resolveApiErrorMessage(error, labels.stageFailed), 'error');
        return;
      }
    }

    let shortHash: string;
    try {
      const response = await commitMutation.mutateAsync({
        title: trimmedTitle,
        body: body.trim(),
        amend,
      });
      shortHash = response.hash.slice(0, 8);
    } catch (error) {
      toast(resolveApiErrorMessage(error, commitLabels.error), 'error');
      return;
    }
    onCommitted();

    if (action === 'commit') {
      toast(commitLabels.success.replace('{hash}', shortHash), 'success');
      return;
    }

    if (action === 'commit-and-sync') {
      try {
        await pullMutation.mutateAsync({});
      } catch (error) {
        onRemoteFailure(error);
        toast(resolveApiErrorMessage(error, labels.pullFailed), 'error');
        return;
      }
    }

    try {
      await pushMutation.mutateAsync({});
    } catch (error) {
      onRemoteFailure(error);
      toast(resolveApiErrorMessage(error, labels.pushFailed), 'error');
      return;
    }
    // The banner describes a remote operation that failed; a push that just
    // succeeded retires it, exactly as the branch-row buttons do.
    onRemoteFailure(null);
    const success = action === 'commit-and-sync' ? labels.synced : labels.pushed;
    toast(success.replace('{hash}', shortHash), 'success');
  };

  return {
    run,
    pending:
      stageMutation.isPending ||
      commitMutation.isPending ||
      pullMutation.isPending ||
      pushMutation.isPending,
  };
}

export function CommitActions({
  actions,
  branch,
  amend,
  hasTitle,
  hasStagedChanges,
  hasUnstagedWork,
  generating,
  canGenerate,
  onGenerate,
}: {
  readonly actions: CommitActionsController;
  readonly branch: GitBranchInfo;
  readonly amend: boolean;
  readonly hasTitle: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedWork: boolean;
  readonly generating: boolean;
  readonly canGenerate: boolean;
  readonly onGenerate: () => void;
}) {
  const { t } = useI18n();
  const labels = t.git.commitActions;
  const commitLabels = t.git.commit;
  const [menuOpen, setMenuOpen] = useState(false);

  const busy = actions.pending || generating;
  // Amending replaces HEAD, so it commits even with nothing staged.
  const canCommit = hasTitle && (hasStagedChanges || amend);
  const select = (action: CommitAction) => {
    setMenuOpen(false);
    void actions.run(action);
  };

  return (
    <div className="flex items-stretch gap-1.5">
      <button
        type="button"
        aria-label={commitLabels.generate}
        title={generating ? commitLabels.generating : commitLabels.generate}
        disabled={!canGenerate || busy}
        onClick={onGenerate}
        className="flex w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles size={14} className={generating ? 'animate-pulse' : undefined} />
      </button>
      <SplitButton
        className="flex-1"
        onClick={() => void actions.run('commit')}
        loading={actions.pending}
        disabled={busy || !canCommit}
        menuDisabled={busy}
        menuLabel={labels.menu}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        menu={
          <>
            <MenuItem disabled={!canCommit} onSelect={() => select('commit')}>
              {labels.commit}
            </MenuItem>
            <MenuItem
              disabled={!hasTitle || !hasUnstagedWork}
              onSelect={() => select('stage-all-and-commit')}
            >
              {labels.stageAllAndCommit}
            </MenuItem>
            <MenuItem
              disabled={!canCommit || branch.name === null}
              onSelect={() => select('commit-and-push')}
            >
              {labels.commitAndPush}
            </MenuItem>
            <MenuItem
              disabled={!canCommit || !branch.upstream}
              onSelect={() => select('commit-and-sync')}
            >
              {labels.commitAndSync}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<History size={13} />} onSelect={() => select('amend')}>
              {commitLabels.amendLabel}
            </MenuItem>
          </>
        }
      >
        <Check size={14} className="shrink-0" />
        <span className="truncate">
          {actions.pending ? commitLabels.submitting : commitLabels.submit}
        </span>
      </SplitButton>
    </div>
  );
}
