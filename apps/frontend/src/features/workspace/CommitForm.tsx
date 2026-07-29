import type { GenerateCommitMessageResponse, GitBranchInfo } from '@mangostudio/shared/git';
import { History, Info, Sparkles, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { CommitActions, useCommitActions } from './CommitActions';
import { useGenerateCommitMessage, useGitHeadMessage } from './hooks/use-git-state';

const AMEND_CONFIRMED_KEY = 'mangostudio.git.amend-confirmed';

export function CommitForm({
  chatId,
  branch,
  hasChanges,
  hasStagedChanges,
  hasUnstagedWork,
  onRemoteFailure,
}: {
  readonly chatId: string;
  readonly branch: GitBranchInfo;
  readonly hasChanges: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedWork: boolean;
  readonly onRemoteFailure: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.commit;
  const amendLabels = t.git.amendConfirm;
  const overwriteLabels = t.git.commitMessageOverwrite;
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
  // The prefill runs once per amended commit, so editing the prefilled text is
  // not undone by a refetch of the same HEAD.
  const prefilledHash = useRef<string | null>(null);
  const headMessage = useGitHeadMessage(chatId, amend);

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

  const actions = useCommitActions({
    chatId,
    title,
    body,
    amend,
    onCommitted: () => {
      updateTitle('');
      updateBody('');
      setAmend(false);
      setDiffWasTruncated(false);
    },
    onEnterAmend: () => {
      if (amend) return;
      if (sessionStorage.getItem(AMEND_CONFIRMED_KEY) === 'true') {
        setAmend(true);
        return;
      }
      setConfirmAmend(true);
    },
    onRemoteFailure,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: applySuggestion only writes state and refs, and re-running on its identity would re-prefill an edited draft.
  useEffect(() => {
    if (!amend) {
      prefilledHash.current = null;
      return;
    }
    const head = headMessage.data;
    if (!head || prefilledHash.current === head.hash) return;
    prefilledHash.current = head.hash;
    const suggestion = { title: head.title, body: head.body, truncated: false };
    // The overwrite dialog is the same guard the generator uses: never replace
    // text the author typed without asking.
    if (titleRef.current.trim() || bodyRef.current.trim()) {
      setPendingSuggestion(suggestion);
      return;
    }
    applySuggestion(suggestion);
  }, [amend, headMessage.data]);

  useEffect(() => {
    if (!amend || !headMessage.error) return;
    toast(resolveApiErrorMessage(headMessage.error, t.git.headMessage.loadError), 'error');
    setAmend(false);
  }, [amend, headMessage.error, toast, t.git.headMessage.loadError]);

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
      // The notice describes the applied suggestion, so a failed run must not leave it standing.
      setDiffWasTruncated(false);
      toast(resolveApiErrorMessage(error, labels.generateError), 'error');
    }
  };

  // The app has no shortcut registry, so the default action is bound where it
  // is used rather than through a new global layer.
  const handleShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void actions.run('commit');
  };

  return (
    <section className="space-y-2">
      {amend ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-4 text-warning">
          <History size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{labels.amendLabel}</span>
            <span className="block opacity-80">
              {headMessage.isLoading ? t.git.headMessage.loading : labels.amendHint}
            </span>
          </span>
          <button
            type="button"
            aria-label={labels.amendExit}
            title={labels.amendExit}
            onClick={() => setAmend(false)}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-warning/20"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}

      <label className="block space-y-1">
        <span className="sr-only">{labels.titleLabel}</span>
        <input
          value={title}
          onChange={(event) => updateTitle(event.target.value)}
          onKeyDown={handleShortcut}
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
          onKeyDown={handleShortcut}
          aria-label={labels.bodyLabel}
          placeholder={labels.bodyPlaceholder}
          rows={2}
          className="w-full resize-y rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-xs text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/60"
        />
      </label>

      <CommitActions
        actions={actions}
        branch={branch}
        amend={amend}
        hasTitle={title.trim().length > 0}
        hasStagedChanges={hasStagedChanges}
        hasUnstagedWork={hasUnstagedWork}
        generating={generateMutation.isPending}
        canGenerate={hasChanges}
        onGenerate={() => void handleGenerate()}
      />

      {diffWasTruncated ? (
        <p className="flex items-start gap-1.5 text-[10px] leading-4 text-on-surface-variant/70">
          <Info size={12} className="mt-0.5 shrink-0" />
          {labels.truncatedNotice}
        </p>
      ) : null}

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
