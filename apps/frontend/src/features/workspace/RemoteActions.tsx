import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { GitBranchInfo } from '@mangostudio/shared/git';
import { CloudDownload, CloudUpload } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { ApiError, cn, resolveApiErrorMessage } from '@/lib/utils';

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
      <div className="flex shrink-0 items-center gap-1">
        <RemoteButton
          label={labels.fetch}
          disabled={pending}
          onClick={() => void run('fetch')}
          icon={<CloudDownload size={ICON_SM} />}
        />
        {branch.behind > 0 ? (
          <RemoteButton
            label={pullLabel}
            badge={branch.behind}
            highlight
            disabled={pending}
            onClick={() => void run('pull')}
            icon={<CloudDownload size={ICON_SM} />}
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
            icon={<CloudUpload size={ICON_SM} />}
          />
        ) : null}
      </div>

      {guidance ? (
        <Callout tone="warning" className="mt-2 w-full">
          <p>{guidance}</p>
          {canForcePush ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={pending}
              onClick={() => setConfirmForcePush(true)}
            >
              {labels.forcePush}
            </Button>
          ) : null}
        </Callout>
      ) : null}

      {confirmForcePush ? (
        <Dialog
          size="sm"
          title={labels.forcePushConfirmTitle}
          description={labels.forcePushConfirmHint}
          onClose={() => setConfirmForcePush(false)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setConfirmForcePush(false)}>
                {labels.forcePushCancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={pushMutation.isPending}
                onClick={() => void forcePush()}
              >
                {labels.forcePushConfirm}
              </Button>
            </>
          }
        />
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
    <Button
      type="button"
      variant="subtle"
      size="sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('gap-1 px-1.5', highlight ? 'text-fg' : 'text-fg-muted')}
    >
      {icon}
      {badge !== undefined ? <span className="font-mono text-micro">{badge}</span> : null}
    </Button>
  );
}
