import type { GenerateCommitMessageResponse, GitBranchInfo } from '@mangostudio/shared/git';
import { History, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn, resolveApiErrorMessage } from '@/lib/utils';

import { CommitActions, useCommitActions } from './CommitActions';
import { IconButton } from './components/IconButton';
import { useGenerateCommitMessage, useGitHeadMessage } from './hooks/use-git-state';

/** The subject line's soft limit is 72; the counter says so from here on. */
const TITLE_COUNT_FROM = 50;

export function CommitForm({
  chatId,
  branch,
  hasChanges,
  hasStagedChanges,
  hasUnstagedWork,
  amend,
  onEnterAmend,
  onExitAmend,
  onRemoteFailure,
}: {
  readonly chatId: string;
  readonly branch: GitBranchInfo;
  readonly hasChanges: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedWork: boolean;
  /** Amend mode is the panel's (`useAmendMode`): its menu can enter it on a clean tree, where this form is not drawn. */
  readonly amend: boolean;
  readonly onEnterAmend: () => void;
  readonly onExitAmend: () => void;
  readonly onRemoteFailure: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.commit;
  const overwriteLabels = t.git.commitMessageOverwrite;
  const generateMutation = useGenerateCommitMessage(chatId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
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

  const bodyId = useId();
  const showTitleCount = title.length >= TITLE_COUNT_FROM;

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
      onExitAmend();
      setDiffWasTruncated(false);
    },
    onEnterAmend,
    onRemoteFailure,
  });

  // applySuggestion only writes state and refs, and re-running on its identity would re-prefill an edited draft.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applySuggestion identity must not re-prefill an edited draft.
  }, [amend, headMessage.data]);

  useEffect(() => {
    if (!amend || !headMessage.error) return;
    toast(resolveApiErrorMessage(headMessage.error, t.git.headMessage.loadError), 'error');
    onExitAmend();
  }, [amend, headMessage.error, toast, t.git.headMessage.loadError, onExitAmend]);

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
            <IconButton label={labels.amendExit} onClick={onExitAmend}>
              <X size={ICON_SM} />
            </IconButton>
          }
        >
          {headMessage.isLoading ? t.git.headMessage.loading : labels.amendHint}
        </Callout>
      ) : null}

      {/*
        Both fields carry a visible label, as every `Input` does: the
        placeholder is an example message, and an instruction kept there was
        gone the moment anyone typed.

        The counter is the field's own trailing edge and appears only near the
        limit. A row of its own showed `0/72` under an empty field for 20px of
        a panel whose job is the file list below it. It is pinned to the field's
        32px, not to the wrapper, which also holds the label.
      */}
      <div className="relative">
        <Input
          label={labels.titleLabel}
          value={title}
          onChange={(event) => updateTitle(event.target.value)}
          onKeyDown={handleShortcut}
          maxLength={72}
          placeholder={labels.titlePlaceholder}
          className={cn(showTitleCount && 'pr-14')}
        />
        {showTitleCount ? (
          <span className="pointer-events-none absolute right-3 bottom-0 flex h-8 items-center font-mono text-micro text-fg-subtle">
            {labels.titleCount.replace('{count}', String(title.length))}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={bodyId} className="text-sm font-medium text-fg">
          {labels.bodyLabel}
        </label>
        {/* Two lines at rest, three once it is being written in or holds text. */}
        <Textarea
          id={bodyId}
          value={body}
          onChange={(event) => updateBody(event.target.value)}
          onKeyDown={handleShortcut}
          placeholder={labels.bodyPlaceholder}
          rows={2}
          className={cn('max-h-40 min-h-16 focus:min-h-24', body && 'min-h-24')}
        />
      </div>

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

      {pendingSuggestion ? (
        <Dialog
          size="sm"
          title={overwriteLabels.title}
          description={overwriteLabels.description}
          onClose={() => setPendingSuggestion(null)}
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
