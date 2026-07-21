import type { GitBranchInfo } from '@mangostudio/shared/git';
import { ArrowDown, ArrowUp, CloudDownload } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useGitFetch, useGitPull, useGitPush } from './hooks/use-git-state';

export function RemoteActions({
  chatId,
  branch,
}: {
  readonly chatId: string;
  readonly branch: GitBranchInfo;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.remote;
  const [prune, setPrune] = useState(true);
  const fetchMutation = useGitFetch(chatId);
  const pullMutation = useGitPull(chatId);
  const pushMutation = useGitPush(chatId);
  const pending = fetchMutation.isPending || pullMutation.isPending || pushMutation.isPending;

  const run = async (operation: 'fetch' | 'pull' | 'push') => {
    try {
      if (operation === 'fetch') await fetchMutation.mutateAsync({ prune });
      else if (operation === 'pull') await pullMutation.mutateAsync({});
      else await pushMutation.mutateAsync({});
      toast(
        operation === 'fetch'
          ? labels.fetched
          : operation === 'pull'
            ? labels.pulled
            : labels.pushed,
        'success'
      );
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  return (
    <div className="mt-2 space-y-2 pl-6">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => void run('fetch')}
          className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-surface-container-high px-2 py-1 text-[10px] font-semibold text-on-surface-variant hover:text-primary disabled:cursor-wait disabled:opacity-50"
        >
          <CloudDownload size={11} />
          {fetchMutation.isPending ? labels.fetching : labels.fetch}
        </button>
        {branch.behind > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run('pull')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary disabled:cursor-wait disabled:opacity-50"
          >
            <ArrowDown size={11} />
            {pullMutation.isPending
              ? labels.pulling
              : labels.pull.replace('{count}', String(branch.behind))}
          </button>
        ) : null}
        {branch.ahead > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run('push')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary disabled:cursor-wait disabled:opacity-50"
          >
            <ArrowUp size={11} />
            {pushMutation.isPending
              ? labels.pushing
              : labels.push.replace('{count}', String(branch.ahead))}
          </button>
        ) : null}
      </div>
      <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-on-surface-variant">
        <input
          type="checkbox"
          checked={prune}
          onChange={(event) => setPrune(event.target.checked)}
          className="accent-primary"
        />
        {labels.prune}
      </label>
    </div>
  );
}
