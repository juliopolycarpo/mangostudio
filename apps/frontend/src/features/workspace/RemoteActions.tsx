import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { GitBranchInfo } from '@mangostudio/shared/git';
import { CloudDownload, CloudUpload } from 'lucide-react';
import type { ReactNode } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import { readGitPanelPrefs } from './git-panel-prefs';
import { useGitFetch, useGitPull, useGitPush } from './hooks/use-git-state';

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
        <p className="mt-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] leading-4 text-warning">
          {guidance}
        </p>
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
