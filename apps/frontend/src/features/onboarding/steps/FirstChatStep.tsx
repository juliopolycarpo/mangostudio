/** Explicit first-chat operations survive reloads; transcript text never admits a turn. */

import { GENERATION_PROMPT_MAX_LENGTH } from '@mangostudio/shared/generation/values';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import { Textarea } from '@/components/ui/Textarea';
import {
  chatKeys,
  messageKeys,
  useCreateChatMutation,
  useUpdateChatMutation,
} from '@/features/chat/queries';
import { sendWithExternalConsent } from '@/features/external-agents/send-with-consent';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { submitOperation } from '@/services/operation-service';

import { StepFrame } from '../StepFrame';
import { useFirstChatOperation } from '../use-first-chat-operation';

interface FirstChatStepProps {
  readonly environmentId: string;
  readonly state: OnboardingState;
  readonly onChange: (updater: (current: OnboardingState) => OnboardingState) => Promise<void>;
  readonly answered: boolean;
  /** Leave for the chat itself. Finishes the run — see the button below. */
  readonly onOpenChat: () => Promise<void>;
  /**
   * Raised while this step is about to write the progress record itself, so the
   * buttons that write it too can stand down. It covers creating the chat and
   * storing its id — not the send that follows, which writes nothing here and
   * can take a minute a person must be able to leave.
   */
  readonly onWritingChange: (writing: boolean) => void;
  /**
   * Back to the folder step, from the notice that says this one has nowhere to
   * work. Navigation only: it opens the step, not its picker.
   */
  readonly onGoToFolder: () => void;
}

export function FirstChatStep({
  environmentId,
  state,
  onChange,
  answered,
  onOpenChat,
  onWritingChange,
  onGoToFolder,
}: FirstChatStepProps) {
  const { t } = useI18n();
  const s = t.onboarding.chat;
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(state.turnOperation?.prompt ?? s.defaultPrompt);
  const [isSending, setSending] = useState(false);
  const [hasFailed, setFailed] = useState(false);
  const createChat = useCreateChatMutation();
  const updateChat = useUpdateChatMutation();
  const operation = useFirstChatOperation(
    state.chatId ? state.turnOperation?.operationId : state.createChatOperation?.operationId
  );
  const sending = useRef(false);
  useEffect(() => {
    if (state.turnOperation) setPrompt(state.turnOperation.prompt);
  }, [state.turnOperation]);
  useEffect(() => {
    const receipt = operation.data;
    if (!state.chatId && receipt?.kind === 'create-chat' && receipt.chatId) {
      onWritingChange(true);
      void onChange((current) => ({ ...current, chatId: receipt.chatId ?? undefined }))
        .catch(() => setFailed(true))
        .finally(() => onWritingChange(false));
    }
  }, [operation.data, state.chatId, onChange, onWritingChange]);
  useEffect(() => {
    if (operation.data?.state === 'completed' && state.chatId) {
      void queryClient.invalidateQueries({ queryKey: messageKeys.list(state.chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.all });
    }
  }, [operation.data?.state, state.chatId, queryClient]);

  const runnerName =
    state.runner?.kind === 'external'
      ? t.library.targets[state.runner.targetId]
      : t.library.targets.mangostudio;

  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    setSending(true);
    setFailed(false);
    let pendingOperationId: string | undefined;
    let pendingCreationId: string | undefined;
    try {
      // Persist identity and exact input before sending either request. A lost
      // settings acknowledgement stops here; reload reads the committed identity.
      let creation = state.createChatOperation ?? {
        operationId: crypto.randomUUID(),
        title: prompt.slice(0, 60),
      };
      let turn = state.turnOperation ?? { operationId: crypto.randomUUID(), prompt };
      onWritingChange(true);
      let chatId = state.chatId;
      try {
        await onChange((current) => {
          // Another tab may have recorded identity since this render. Keep
          // the confirmed operation instead of replacing it with our candidate.
          creation = current.createChatOperation ?? creation;
          turn = current.turnOperation ?? turn;
          chatId = current.chatId ?? chatId;
          pendingOperationId = turn.operationId;
          pendingCreationId = creation.operationId;
          return {
            ...current,
            requiresTurnReceipt: true,
            createChatOperation: creation,
            turnOperation: turn,
          };
        });
        if (!chatId) {
          const chat = await createChat.mutateAsync(creation);
          chatId = chat.id;
          await onChange((current) => ({ ...current, chatId }));
        }
      } finally {
        onWritingChange(false);
      }

      await updateChat.mutateAsync({
        id: chatId,
        updates: {
          environmentId,
          ...(state.workdir ? { workdir: state.workdir } : {}),
          ...(state.runner ? { runner: state.runner } : {}),
        },
      });
      const sendChatId = chatId;
      await sendWithExternalConsent(sendChatId, async () => {
        const receipt = await submitOperation({
          chatId: sendChatId,
          prompt: turn.prompt,
          operationId: turn.operationId,
        });
        queryClient.setQueryData(['product-operation', turn.operationId], receipt);
      });
    } catch {
      setFailed(true);
      if (pendingCreationId)
        await queryClient.invalidateQueries({ queryKey: ['product-operation', pendingCreationId] });
      if (pendingOperationId)
        await queryClient.invalidateQueries({
          queryKey: ['product-operation', pendingOperationId],
        });
    } finally {
      sending.current = false;
      setSending(false);
    }
  };

  const newRequest = async () => {
    onWritingChange(true);
    try {
      await onChange((current) => ({
        ...current,
        turnOperation: undefined,
        requiresTurnReceipt: true,
        ...(!current.chatId ? { createChatOperation: undefined } : {}),
      }));
    } catch {
      setFailed(true);
    } finally {
      onWritingChange(false);
    }
  };
  const receipt = operation.data;
  const busy = receipt?.state === 'accepted' || receipt?.state === 'running';

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      {state.workdir ? (
        <p className="text-xs text-fg-muted" data-testid="onboarding-chat-summary">
          {formatMessage(s.summary, { runner: runnerName, workdir: state.workdir })}
        </p>
      ) : (
        // A notice the person can act on carries the action: the folder step is
        // four Backs away on a phone, which has no step list to jump with.
        <Callout
          tone="warning"
          data-testid="onboarding-chat-needs-folder"
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="onboarding-chat-go-to-folder"
              onClick={onGoToFolder}
            >
              {s.goToFolder}
            </Button>
          }
        >
          {s.needsFolder}
        </Callout>
      )}

      <div className="space-y-1">
        <label htmlFor="onboarding-prompt" className="text-sm font-medium text-fg">
          {s.promptLabel}
        </label>
        <Textarea
          id="onboarding-prompt"
          data-testid="onboarding-prompt"
          rows={3}
          maxLength={GENERATION_PROMPT_MAX_LENGTH}
          // Nowhere to send it yet: a live field beside a disabled Send invites
          // writing a message that has no place to go.
          disabled={!state.workdir || Boolean(state.turnOperation)}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>

      {state.chatId && !answered ? <p className="text-xs text-fg-muted">{s.resume}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="onboarding-send-prompt"
          loading={isSending}
          disabled={
            !state.workdir ||
            prompt.trim().length === 0 ||
            answered ||
            Boolean(receipt) ||
            operation.isError ||
            isSending
          }
          onClick={() => void send()}
        >
          {isSending ? s.sending : s.send}
        </Button>
        {/* A button rather than a link: `/` is behind the gate that sent this
            person here, so leaving without recording completion lands them
            back in this wizard. Finishing on the way out is also what makes the
            documented escape from a turn that failed server-side — open the
            chat, edit the prompt — a route that exists. The chat list opens on
            its most recent entry, which is this one. */}
        {state.chatId ? (
          <Button
            variant="subtle"
            data-testid="onboarding-open-chat"
            onClick={() => void onOpenChat()}
          >
            {s.openChat}
          </Button>
        ) : null}
      </div>

      {answered ? (
        <Callout tone="success" data-testid="onboarding-chat-answered">
          {s.answered}
        </Callout>
      ) : null}

      {receipt ? (
        <Callout
          tone={receipt.state === 'failed' || receipt.state === 'unresolved' ? 'warning' : 'info'}
          data-testid="onboarding-operation-state"
        >
          {busy ? <Spinner size="sm" /> : null}
          {s.operationStates[receipt.state]}
        </Callout>
      ) : null}
      {operation.isError ? <Callout tone="warning">{s.operationUnavailable}</Callout> : null}
      {(receipt && !busy) || operation.isError ? (
        <Button
          variant="secondary"
          data-testid="onboarding-new-operation"
          disabled={isSending}
          onClick={() => void newRequest()}
        >
          {s.newRequest}
        </Button>
      ) : null}

      {hasFailed ? (
        <Callout tone="danger" data-testid="onboarding-chat-failed">
          {s.failed}
        </Callout>
      ) : null}
    </StepFrame>
  );
}
