import type { GenerateCommitMessageResponse, GitBranchInfo } from '@mangostudio/shared/git';
import { History, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { CommitActions, useCommitActions } from './CommitActions';
import { IconButton } from './components/IconButton';
import { WorkspaceDialog } from './components/WorkspaceDialog';
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
    // The shortcut mirrors the primary button, which is disabled without
    // something to commit; firing anyway would only earn a rejected request.
    if (!hasStagedChanges && !amend) return;
    void actions.run('commit');
  };

  return (
    <section className="space-y-3">
      {amend ? (
        <Callout
          tone="warning"
          icon={<History size={ICON_MD} />}
          title={labels.amendLabel}
          action={
            <IconButton label={labels.amendExit} onClick={() => setAmend(false)}>
              <X size={ICON_SM} />
            </IconButton>
          }
        >
          {headMessage.isLoading ? t.git.headMessage.loading : labels.amendHint}
        </Callout>
      ) : null}

      <div className="space-y-1">
        <Input
          value={title}
          onChange={(event) => updateTitle(event.target.value)}
          onKeyDown={handleShortcut}
          maxLength={72}
          aria-label={labels.titleLabel}
          placeholder={labels.titlePlaceholder}
        />
        <p className="text-right font-mono text-micro text-fg-subtle">
          {labels.titleCount.replace('{count}', String(title.length))}
        </p>
      </div>
      <Textarea
        value={body}
        onChange={(event) => updateBody(event.target.value)}
        onKeyDown={handleShortcut}
        aria-label={labels.bodyLabel}
        placeholder={labels.bodyPlaceholder}
        rows={2}
        className="min-h-16"
      />

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

      {diffWasTruncated ? <Callout tone="info">{labels.truncatedNotice}</Callout> : null}

      {confirmAmend ? (
        <WorkspaceDialog
          titleId="git-amend-confirm-title"
          title={amendLabels.title}
          description={amendLabels.description}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setConfirmAmend(false)}>
                {amendLabels.cancel}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  sessionStorage.setItem(AMEND_CONFIRMED_KEY, 'true');
                  setConfirmAmend(false);
                  setAmend(true);
                }}
              >
                {amendLabels.confirm}
              </Button>
            </>
          }
        />
      ) : null}

      {pendingSuggestion ? (
        <WorkspaceDialog
          titleId="git-commit-message-overwrite-title"
          title={overwriteLabels.title}
          description={overwriteLabels.description}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setPendingSuggestion(null)}>
                {overwriteLabels.cancel}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  applySuggestion(pendingSuggestion);
                  setPendingSuggestion(null);
                }}
              >
                {overwriteLabels.confirm}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  );
}
