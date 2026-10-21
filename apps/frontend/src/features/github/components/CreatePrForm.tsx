import type { GithubCreatePrResponse } from '@mangostudio/shared/github';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import { createPullRequest, pushCurrentBranch } from '../api';
import { githubKeys } from '../queries';

/**
 * A failure in the push half of the combined action, carrying the sentence that
 * describes it.
 *
 * A distinct type rather than a flag because the two halves fail for unrelated
 * reasons — a rejected push is about the remote, a rejected create is about
 * GitHub — and one toast for both sends the user looking in the wrong place.
 */
class PushFailedError extends Error {}

interface CreatePrFormProps {
  readonly chatId: string;
  /**
   * True when the current branch has no upstream. Not a convenience flag: it
   * decides whether the branch is pushed first, and getting it wrong is the
   * difference between a pull request and a hung subprocess.
   */
  readonly needsPush: boolean;
  readonly defaultTitle: string;
  readonly onDone: () => void;
}

/**
 * The create-pull-request form, with the push it usually needs first.
 *
 * `gh pr create` on a branch the remote has never seen prompts for where to
 * push it. Prompts are disabled on the runtime, so that prompt is not a
 * question — it is a hang, and then a failure, on precisely the branch somebody
 * most wants a pull request for. So when the branch has no upstream this runs
 * `POST /git/push` first, which already picks `--set-upstream` in that case,
 * and only then asks GitHub for the pull request. One button, because "push"
 * and "create the pull request" are one intention.
 *
 * @example
 * <CreatePrForm chatId={chatId} needsPush defaultTitle="Fix the rail" onDone={close} />
 */
export function CreatePrForm({ chatId, needsPush, defaultTitle, onDone }: CreatePrFormProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const titleId = useId();
  const bodyId = useId();

  const mutation = useMutation({
    mutationFn: async (): Promise<GithubCreatePrResponse> => {
      // Sequential, not concurrent: the pull request is only meaningful once
      // the head branch exists on the remote.
      //
      // The push is wrapped rather than left to the shared error handler so the
      // toast names the step that actually failed. "The pull request could not
      // be created" after a rejected push is the wrong diagnosis — it sends the
      // user looking at GitHub when the problem is their remote.
      if (needsPush) {
        try {
          await pushCurrentBranch(chatId);
        } catch (error) {
          throw new PushFailedError(resolveApiErrorMessage(error, t.github.createPr.pushError));
        }
      }
      return await createPullRequest({ chatId, title, body: body || undefined, draft });
    },
    onSuccess: async (result) => {
      if (result.state !== 'ok') {
        toast(t.github.connection[result.state], 'error');
        return;
      }
      toast(
        formatMessage(t.github.createPr.success, { number: String(result.pr.number) }),
        'success'
      );
      // Every list this could appear in, and the branch context that now has a
      // pull request where a moment ago it had none.
      await queryClient.invalidateQueries({ queryKey: githubKeys.all });
      onDone();
    },
    onError: (error) => {
      // The push already produced the sentence that names its own failure;
      // re-resolving it here would replace it with the create-PR fallback.
      if (error instanceof PushFailedError) {
        toast(error.message, 'error');
        return;
      }
      toast(resolveApiErrorMessage(error, t.github.createPr.error), 'error');
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <form onSubmit={submit}>
      <Card padded={false} className="space-y-3 p-3">
        <Input
          id={titleId}
          label={t.github.createPr.titleLabel}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t.github.createPr.titlePlaceholder}
          maxLength={256}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={bodyId} className="text-sm font-medium text-fg">
            {t.github.createPr.bodyLabel}
          </label>
          <Textarea
            id={bodyId}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={t.github.createPr.bodyPlaceholder}
            rows={4}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
          <Checkbox checked={draft} onChange={(event) => setDraft(event.target.checked)} />
          {t.github.createPr.draftLabel}
        </label>
        {needsPush ? <Callout tone="warning">{t.github.createPr.pushHint}</Callout> : null}
        <div className="flex justify-end gap-2">
          {/* Disabled while submitting: onDone only closes the form, it does not
              abort the push or create request, so an enabled Cancel would let a
              pull request appear moments after the form it was made in vanished. */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onDone}
            disabled={mutation.isPending}
          >
            {t.github.createPr.cancel}
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || mutation.isPending}>
            {needsPush ? t.github.actions.pushAndCreatePr : t.github.createPr.submit}
          </Button>
        </div>
      </Card>
    </form>
  );
}
