import { ArchiveRestore, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useGitStashes, useStashPop, useStashSave } from './hooks/use-git-state';

/** The stash stack, moved off the panel body into a modal opened from the overflow menu. */
export function StashSheet({
  chatId,
  onClose,
}: {
  readonly chatId: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.stash;
  const stashesQuery = useGitStashes(chatId);
  const saveMutation = useStashSave(chatId);
  const popMutation = useStashPop(chatId);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const pending = saveMutation.isPending || popMutation.isPending;

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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-stash-sheet-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col gap-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <h3
            id="git-stash-sheet-title"
            className="min-w-0 flex-1 text-lg font-bold text-on-surface"
          >
            {labels.title}
          </h3>
          <button
            type="button"
            aria-label={labels.close}
            title={labels.close}
            onClick={onClose}
            className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-2.5">
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
            disabled={pending}
            onClick={() => void save()}
          >
            {saveMutation.isPending ? labels.saving : labels.save}
          </Button>
        </div>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          {stashesQuery.isLoading ? (
            <p className="text-xs text-on-surface-variant">{labels.loading}</p>
          ) : stashesQuery.error ? (
            <p className="text-xs text-error">{labels.loadError}</p>
          ) : stashesQuery.data?.stashes.length ? (
            <ul className="space-y-2">
              {stashesQuery.data.stashes.map((stash) => (
                <li
                  key={stash.index}
                  className="space-y-2 rounded-lg border border-outline-variant/15 bg-surface-container-lowest/40 p-2.5"
                >
                  <div className="min-w-0">
                    <p className="break-words text-xs font-semibold text-on-surface">
                      {stash.message}
                    </p>
                    {stash.branch ? (
                      <p className="truncate font-mono text-[10px] text-on-surface-variant">
                        {stash.branch}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StashAction
                      label={labels.popLabel.replace('{message}', stash.message)}
                      text={labels.pop}
                      icon={<ArchiveRestore size={12} />}
                      disabled={pending}
                      onClick={() => void pop(stash.index)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-on-surface-variant/70">{labels.empty}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StashAction({
  label,
  text,
  icon,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly text: string;
  readonly icon: ReactNode;
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
      className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-surface-container-high px-2 py-1 text-[10px] font-semibold text-on-surface-variant transition-colors hover:text-primary disabled:cursor-wait disabled:opacity-50"
    >
      {icon}
      {text}
    </button>
  );
}
