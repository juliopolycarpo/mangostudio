import type { GenerateCommitMessageResponse } from '@mangostudio/shared/git';
import { History, Info, Sparkles } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useCommit, useGenerateCommitMessage } from './hooks/use-git-state';

const AMEND_CONFIRMED_KEY = 'mangostudio.git.amend-confirmed';

export function CommitForm({
  chatId,
  hasChanges,
  hasStagedChanges,
}: {
  readonly chatId: string;
  readonly hasChanges: boolean;
  readonly hasStagedChanges: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.commit;
  const amendLabels = t.git.amendConfirm;
  const overwriteLabels = t.git.commitMessageOverwrite;
  const commitMutation = useCommit(chatId);
  const generateMutation = useGenerateCommitMessage(chatId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const [confirmAmend, setConfirmAmend] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] = useState<GenerateCommitMessageResponse | null>(
    null
  );
  const [diffWasTruncated, setDiffWasTruncated] = useState(false);
  const titleRef = useRef('');
  const bodyRef = useRef('');

  const updateTitle = (value: string) => {
    titleRef.current = value;
    setTitle(value);
  };

  const updateBody = (value: string) => {
    bodyRef.current = value;
    setBody(value);
  };

  const applySuggestion = (suggestion: GenerateCommitMessageResponse) => {
    updateTitle(suggestion.title);
    updateBody(suggestion.body);
    setDiffWasTruncated(suggestion.truncated);
  };

  const handleAmendChange = (checked: boolean) => {
    if (!checked) {
      setAmend(false);
      return;
    }

    if (sessionStorage.getItem(AMEND_CONFIRMED_KEY) === 'true') {
      setAmend(true);
      return;
    }
    setConfirmAmend(true);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || (!hasStagedChanges && !amend)) return;

    try {
      const response = await commitMutation.mutateAsync({
        title: trimmedTitle,
        body: body.trim(),
        amend,
      });
      toast(labels.success.replace('{hash}', response.hash.slice(0, 8)), 'success');
      updateTitle('');
      updateBody('');
      setAmend(false);
      setDiffWasTruncated(false);
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.error), 'error');
    }
  };

  const handleGenerate = async () => {
    if (!hasChanges) return;
    try {
      const suggestion = await generateMutation.mutateAsync({});
      if (titleRef.current.trim() || bodyRef.current.trim()) {
        setPendingSuggestion(suggestion);
        return;
      }
      applySuggestion(suggestion);
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.generateError), 'error');
    }
  };

  return (
    <section className="space-y-3 border-t border-outline-variant/15 pt-4">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
        {labels.title}
      </h3>
      <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
        <label className="block space-y-1">
          <span className="sr-only">{labels.titleLabel}</span>
          <input
            value={title}
            onChange={(event) => updateTitle(event.target.value)}
            maxLength={72}
            aria-label={labels.titleLabel}
            placeholder={labels.titlePlaceholder}
            className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-xs text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/60"
          />
          <span className="block text-right font-mono text-[10px] text-on-surface-variant/60">
            {labels.titleCount.replace('{count}', String(title.length))}
          </span>
        </label>
        <label className="block">
          <span className="sr-only">{labels.bodyLabel}</span>
          <textarea
            value={body}
            onChange={(event) => updateBody(event.target.value)}
            aria-label={labels.bodyLabel}
            placeholder={labels.bodyPlaceholder}
            rows={3}
            className="w-full resize-y rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-xs text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/60"
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full"
          loading={generateMutation.isPending}
          disabled={!hasChanges || generateMutation.isPending || commitMutation.isPending}
          onClick={() => void handleGenerate()}
        >
          {!generateMutation.isPending ? <Sparkles size={14} /> : null}
          {generateMutation.isPending ? labels.generating : labels.generate}
        </Button>
        {diffWasTruncated ? (
          <p className="flex items-start gap-1.5 text-[10px] leading-4 text-on-surface-variant/70">
            <Info size={12} className="mt-0.5 shrink-0" />
            {labels.truncatedNotice}
          </p>
        ) : null}
        <label className="flex cursor-pointer items-start gap-2 text-xs text-on-surface-variant">
          <input
            type="checkbox"
            checked={amend}
            onChange={(event) => handleAmendChange(event.target.checked)}
            aria-label={labels.amendLabel}
            className="mt-0.5 accent-primary"
          />
          <span>
            <span className="font-semibold text-on-surface">{labels.amendLabel}</span>
            <span className="block text-[10px] leading-4">{labels.amendHint}</span>
          </span>
        </label>
        <Button
          type="submit"
          size="sm"
          className="w-full"
          loading={commitMutation.isPending}
          disabled={
            commitMutation.isPending ||
            generateMutation.isPending ||
            title.trim().length === 0 ||
            (!hasStagedChanges && !amend)
          }
        >
          {commitMutation.isPending ? labels.submitting : labels.submit}
        </Button>
      </form>

      {confirmAmend ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-amend-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm space-y-5 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
            <div className="space-y-2 text-center">
              <History className="mx-auto text-warning" size={30} />
              <h3 id="git-amend-confirm-title" className="text-lg font-bold text-on-surface">
                {amendLabels.title}
              </h3>
              <p className="text-sm leading-5 text-on-surface-variant/70">
                {amendLabels.description}
              </p>
            </div>
            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setConfirmAmend(false)}
              >
                {amendLabels.cancel}
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() => {
                  sessionStorage.setItem(AMEND_CONFIRMED_KEY, 'true');
                  setConfirmAmend(false);
                  setAmend(true);
                }}
              >
                {amendLabels.confirm}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingSuggestion ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-commit-message-overwrite-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm space-y-5 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
            <div className="space-y-2 text-center">
              <Sparkles className="mx-auto text-primary" size={30} />
              <h3
                id="git-commit-message-overwrite-title"
                className="text-lg font-bold text-on-surface"
              >
                {overwriteLabels.title}
              </h3>
              <p className="text-sm leading-5 text-on-surface-variant/70">
                {overwriteLabels.description}
              </p>
            </div>
            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setPendingSuggestion(null)}
              >
                {overwriteLabels.cancel}
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() => {
                  applySuggestion(pendingSuggestion);
                  setPendingSuggestion(null);
                }}
              >
                {overwriteLabels.confirm}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
