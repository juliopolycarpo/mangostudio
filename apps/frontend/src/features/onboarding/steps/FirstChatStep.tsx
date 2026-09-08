/**
 * The step that proves the whole thing works: one chat, in the chosen folder,
 * answered by the chosen runner.
 *
 * Sending is always an explicit click — nothing is dispatched by arriving here.
 * The two failure shapes that matter are both about *repeating*: a reload after
 * the chat was created, and a second click after the prompt was accepted but
 * the answer was lost. Neither may produce a second chat or a second turn, so
 * the chat reference is persisted the moment creation returns, before anything
 * is sent, and the transcript is consulted for an identical prompt before one
 * is sent again.
 */

import { GENERATION_PROMPT_MAX_LENGTH } from '@mangostudio/shared/generation';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import {
  chatKeys,
  messageKeys,
  messagesQueryOptions,
  useCreateChatMutation,
  useMessagesQuery,
  useUpdateChatMutation,
} from '@/features/chat/queries';
import { sendWithExternalConsent } from '@/features/external-agents/send-with-consent';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { respondTextStream } from '@/services/generation-service';
import { StepFrame } from '../StepFrame';

interface FirstChatStepProps {
  readonly environmentId: string;
  readonly state: OnboardingState;
  readonly onChange: (updater: (current: OnboardingState) => OnboardingState) => Promise<void>;
  readonly answered: boolean;
}

export function FirstChatStep({ environmentId, state, onChange, answered }: FirstChatStepProps) {
  const { t } = useI18n();
  const s = t.onboarding.chat;
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(s.defaultPrompt);
  const [isSending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const createChat = useCreateChatMutation();
  const updateChat = useUpdateChatMutation();
  const messages = useMessagesQuery(state.chatId ?? null);

  const runnerName =
    state.runner?.kind === 'external'
      ? t.library.targets[state.runner.targetId]
      : t.library.targets.mangostudio;

  const alreadyAsked = (text: string): boolean =>
    (messages.data?.pages ?? []).some((page) =>
      page.messages.some((message) => message.role === 'user' && message.text === text)
    );

  const send = async () => {
    setSending(true);
    setFailure(null);
    try {
      let chatId = state.chatId;
      if (!chatId) {
        const chat = await createChat.mutateAsync({ title: prompt.slice(0, 60) });
        chatId = chat.id;
        // Persisted before a single byte of the prompt is sent. A crash on the
        // next line then costs a retry, not a duplicate chat.
        await onChange((current) => ({ ...current, chatId }));
      }

      await updateChat.mutateAsync({
        id: chatId,
        updates: {
          environmentId,
          ...(state.workdir ? { workdir: state.workdir } : {}),
          ...(state.runner ? { runner: state.runner } : {}),
        },
      });

      // A resumed flow may be looking at a transcript that already carries this
      // exact prompt: the send was accepted and only the answer was lost.
      // Re-reading is cheap; a second identical turn is not.
      await queryClient.refetchQueries({ queryKey: chatKeys.detail(chatId) });
      const fresh = await queryClient.fetchInfiniteQuery(messagesQueryOptions(chatId));
      const asked = fresh.pages.some((page) =>
        page.messages.some((message) => message.role === 'user' && message.text === prompt)
      );

      if (!asked) {
        const sendChatId = chatId;
        // Wrapped in the same consent retry the composer uses: a first send to
        // a vendor CLI is exactly the send that gets refused for a disclosure
        // nobody has acknowledged yet.
        await sendWithExternalConsent(sendChatId, () =>
          respondTextStream({ chatId: sendChatId, prompt }, () => {
            // Chunks are the chat page's business; this step only needs to know
            // that the turn ran. The transcript below is the source of truth
            // for whether anything was actually answered.
          })
        );
      }

      // The transcript is what says whether anything answered, and it lives
      // under its own key — invalidating the chat list alone would leave this
      // step reading the empty transcript it fetched a moment ago to decide
      // whether to send.
      await queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) });
      await queryClient.invalidateQueries({ queryKey: chatKeys.all });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : s.failed);
    } finally {
      setSending(false);
    }
  };

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      {state.workdir ? (
        <p className="text-on-surface-variant/70 text-xs" data-testid="onboarding-chat-summary">
          {formatMessage(s.summary, { runner: runnerName, workdir: state.workdir })}
        </p>
      ) : (
        <p className="text-on-surface-variant text-sm" data-testid="onboarding-chat-needs-folder">
          {s.needsFolder}
        </p>
      )}

      <div className="space-y-1.5">
        <label
          htmlFor="onboarding-prompt"
          className="font-label font-semibold text-on-surface-variant text-xs uppercase tracking-wider"
        >
          {s.promptLabel}
        </label>
        <textarea
          id="onboarding-prompt"
          data-testid="onboarding-prompt"
          rows={3}
          maxLength={GENERATION_PROMPT_MAX_LENGTH}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="w-full resize-y rounded-2xl border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-on-surface text-sm outline-none focus:border-primary/50"
        />
      </div>

      {state.chatId && !answered ? (
        <p className="text-on-surface-variant/60 text-xs">{s.resume}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="onboarding-send-prompt"
          loading={isSending}
          disabled={!state.workdir || prompt.trim().length === 0 || answered}
          onClick={() => void send()}
        >
          {isSending ? s.sending : s.send}
        </Button>
        {/* The chat list opens on its most recent entry, which is this one —
            there is no per-chat URL to link to. */}
        {state.chatId ? (
          <Link
            to="/"
            className="font-semibold text-primary text-sm hover:underline"
            data-testid="onboarding-open-chat"
          >
            {s.openChat}
          </Link>
        ) : null}
      </div>

      {answered ? (
        <p className="font-semibold text-primary text-sm" data-testid="onboarding-chat-answered">
          {s.answered}
        </p>
      ) : null}

      {!answered && state.chatId && !isSending && alreadyAsked(prompt) ? (
        <p className="flex items-center gap-2 text-on-surface-variant/70 text-sm">
          <Spinner size="sm" />
          {s.waiting}
        </p>
      ) : null}

      {failure ? (
        <p className="text-error text-sm" data-testid="onboarding-chat-failed">
          {s.failed}
        </p>
      ) : null}
    </StepFrame>
  );
}
