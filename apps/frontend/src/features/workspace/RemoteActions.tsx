import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { GitBranchInfo } from '@mangostudio/shared/git';
import { CloudDownload, CloudUpload } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import { readGitPanelPrefs } from './git-panel-prefs';
import { useGitFetch, useGitPull, useGitPush } from './hooks/use-git-state';

/**
 * Divergence the user can only get past by rewriting the remote branch, which
 * is a *rejected push* and nothing else. `NON_FAST_FORWARD` is deliberately
 * absent: it is what `git pull --ff-only` reports, and that pull already
 * advanced the remote-tracking ref, so a lease taken right after it would pass
 * and overwrite the very commits the user asked to integrate.
 */
const LEASE_RECOVERABLE_CODES: readonly string[] = [ERROR_CODES.HISTORY_DIVERGED];

export function RemoteActions({
  chatId,
  branch,
  failure,
  onFailureChange,
}: {
  readonly chatId: string;
  readonly branch: GitBranchInfo;
  readonly failure: unknown;
  readonly onFailureChange: (failure: unknown) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.remote;
  const [confirmForcePush, setConfirmForcePush] = useState(false);
  const fetchMutation = useGitFetch(chatId);
  const pullMutation = useGitPull(chatId);
  const pushMutation = useGitPush(chatId);
  const pending = fetchMutation.isPending || pullMutation.isPending || pushMutation.isPending;

  const resolveGuidance = (error: unknown): string | null => {
    if (!(error instanceof ApiError)) return null;
    if (error.code === ERROR_CODES.AUTH_REQUIRED) return labels.authRequired;
    if (error.code === ERROR_CODES.NON_FAST_FORWARD) return labels.nonFastForward;
    if (error.code === ERROR_CODES.HISTORY_DIVERGED) return labels.historyDiverged;
    return null;
  };

  const guidance = resolveGuidance(failure);
  // The leased force push is a recovery path, never a default affordance: it
  // only exists once a real push has been rejected as diverged.
  const canForcePush =
    failure instanceof ApiError &&
    LEASE_RECOVERABLE_CODES.includes(failure.code ?? '') &&
    Boolean(branch.upstream);

  const run = async (operation: 'fetch' | 'pull' | 'push') => {
    try {
      if (operation === 'fetch') {
        await fetchMutation.mutateAsync({ prune: readGitPanelPrefs().pruneOnFetch });
      } else if (operation === 'pull') {
        await pullMutation.mutateAsync({});
      } else {
        await pushMutation.mutateAsync({});
      }
      onFailureChange(null);
      toast(
        operation === 'fetch'
          ? labels.fetched
          : operation === 'pull'
            ? labels.pulled
            : labels.pushed,
        'success'
      );
    } catch (error) {
      onFailureChange(error);
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const forcePush = async () => {
    try {
      await pushMutation.mutateAsync({ force: 'with-lease' });
      onFailureChange(null);
      setConfirmForcePush(false);
      toast(labels.forcePushed, 'success');
    } catch (error) {
      onFailureChange(error);
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const pushLabel = branch.upstream
    ? labels.push.replace('{count}', String(branch.ahead))
    : labels.publish;
  const pullLabel = labels.pull.replace('{count}', String(branch.behind));

  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5">
        <RemoteButton
          label={labels.fetch}
          disabled={pending}
          onClick={() => void run('fetch')}
          icon={<CloudDownload size={13} />}
        />
        {branch.behind > 0 ? (
          <RemoteButton
            label={pullLabel}
            badge={branch.behind}
            highlight
            disabled={pending}
            onClick={() => void run('pull')}
            icon={<CloudDownload size={13} />}
          />
        ) : null}
        {/*
          A branch with no upstream reports ahead: 0, so it needs its own entry
          point — otherwise a freshly created branch could never be published.
        */}
        {branch.name !== null && (branch.ahead > 0 || !branch.upstream) ? (
          <RemoteButton
            label={pushLabel}
            badge={branch.upstream ? branch.ahead : undefined}
            highlight
            disabled={pending}
            onClick={() => void run('push')}
            icon={<CloudUpload size={13} />}
          />
        ) : null}
      </div>

      {guidance ? (
        <div className="mt-2 space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-2 py-1.5">
          <p className="text-[11px] leading-4 text-warning">{guidance}</p>
          {canForcePush ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmForcePush(true)}
              className="cursor-pointer rounded-full bg-warning/20 px-2 py-1 text-[10px] font-semibold text-warning transition-colors hover:bg-warning/30 disabled:cursor-wait disabled:opacity-50"
            >
              {labels.forcePush}
            </button>
          ) : null}
        </div>
      ) : null}

      {confirmForcePush ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-force-push-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
            <div className="space-y-2">
              <h3 id="git-force-push-title" className="text-lg font-bold text-on-surface">
                {labels.forcePushConfirmTitle}
              </h3>
              <p className="text-sm leading-5 text-on-surface-variant">
                {labels.forcePushConfirmHint}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setConfirmForcePush(false)}
              >
                {labels.forcePushCancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                className="flex-1"
                loading={pushMutation.isPending}
                onClick={() => void forcePush()}
              >
                {labels.forcePushConfirm}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function RemoteButton({
  label,
  icon,
  badge,
  highlight = false,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge?: number;
  readonly highlight?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 transition-colors disabled:cursor-wait disabled:opacity-50 ${
        highlight
          ? 'text-primary hover:bg-primary/10'
          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
      }`}
    >
      {icon}
      {badge !== undefined ? <span className="font-mono text-[10px]">{badge}</span> : null}
    </button>
  );
}
