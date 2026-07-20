import { ArchiveRestore, PackagePlus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useGitStashes, useStashPop, useStashSave } from './hooks/use-git-state';

export function StashSection({ chatId }: { readonly chatId: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.stash;
  const stashesQuery = useGitStashes(chatId);
  const saveMutation = useStashSave(chatId);
  const popMutation = useStashPop(chatId);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);

  const save = async () => {
    try {
      await saveMutation.mutateAsync({ message: message.trim(), includeUntracked });
      setMessage('');
      setIncludeUntracked(false);
      toast(labels.saveSuccess, 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const pop = async (index: number) => {
    try {
      await popMutation.mutateAsync({ index });
      toast(labels.popSuccess, 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  return (
    <section className="space-y-3 border-t border-outline-variant/15 pt-4">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
        <PackagePlus size={13} />
        {labels.title}
      </h3>
      <input
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        aria-label={labels.messageLabel}
        placeholder={labels.messagePlaceholder}
        className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-xs text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/60"
      />
      <label className="flex cursor-pointer items-center gap-2 text-xs text-on-surface-variant">
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(event) => setIncludeUntracked(event.target.checked)}
          aria-label={labels.includeUntracked}
          className="accent-primary"
        />
        {labels.includeUntracked}
      </label>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-full"
        loading={saveMutation.isPending}
        disabled={saveMutation.isPending}
        onClick={() => void save()}
      >
        {saveMutation.isPending ? labels.saving : labels.save}
      </Button>

      {stashesQuery.isLoading ? (
        <p className="text-xs text-on-surface-variant">{labels.loading}</p>
      ) : stashesQuery.error ? (
        <p className="text-xs text-error">{labels.loadError}</p>
      ) : stashesQuery.data?.stashes.length ? (
        <ul className="space-y-2">
          {stashesQuery.data.stashes.map((stash) => (
            <li
              key={stash.index}
              className="flex items-start gap-2 rounded-lg border border-outline-variant/15 bg-surface-container-lowest/40 p-2"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-xs font-semibold text-on-surface">{stash.message}</p>
                {stash.branch ? (
                  <p className="truncate font-mono text-[10px] text-on-surface-variant">
                    {stash.branch}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={labels.popLabel.replace('{message}', stash.message)}
                title={labels.pop}
                disabled={popMutation.isPending}
                onClick={() => void pop(stash.index)}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary disabled:cursor-wait disabled:opacity-50"
              >
                <ArchiveRestore size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-on-surface-variant/70">{labels.empty}</p>
      )}
    </section>
  );
}
