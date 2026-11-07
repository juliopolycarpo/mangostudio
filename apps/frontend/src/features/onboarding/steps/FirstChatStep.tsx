/** Explicit first-chat operations survive reloads; transcript text never admits a turn. */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { GENERATION_PROMPT_MAX_LENGTH } from '@mangostudio/shared/generation/values';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import type { OperationReceipt } from '@mangostudio/shared/operations';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

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
import { ApiError } from '@/lib/utils';
import { submitOperation } from '@/services/operation-service';

import { StepFrame } from '../StepFrame';
import { useFirstChatOperation } from '../use-first-chat-operation';

interface FirstChatStepProps {
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
  const [unavailableChat, setUnavailableChat] = useState<{
    chatId?: string;
    creationId?: string;
  }>();
  const createChat = useCreateChatMutation();
  const updateChat = useUpdateChatMutation();
  const operation = useFirstChatOperation(
    state.chatId ? state.turnOperation?.operationId : state.createChatOperation?.operationId
  );
  const receipt = operation.data;
  const creationId = state.createChatOperation?.operationId;
  const chatUnavailable =
    unavailableChat !== undefined &&
    unavailableChat.chatId === state.chatId &&
    unavailableChat.creationId === creationId;
  const recoveredChatId =
    !state.chatId &&
    receipt?.kind === 'create-chat' &&
    receipt.state === 'completed' &&
    receipt.operationId === creationId
      ? receipt.chatId
      : null;
  const sending = useRef(false);
  const attemptedRecovery = useRef<string | undefined>(undefined);
  const [isRecovering, setRecovering] = useState(false);
  const [failedRecovery, setFailedRecovery] = useState<string>();
  const recoverChat = useCallback(async () => {
    if (!creationId || !recoveredChatId || isRecovering || sending.current) return;
    attemptedRecovery.current = creationId;
    setRecovering(true);
    setFailedRecovery(undefined);
    onWritingChange(true);
    try {
      await onChange((current) =>
        !current.chatId && current.createChatOperation?.operationId === creationId
          ? { ...current, chatId: recoveredChatId }
          : current
      );
    } catch {
      setFailedRecovery(creationId);
    } finally {
      setRecovering(false);
      onWritingChange(false);
    }
  }, [creationId, recoveredChatId, isRecovering, onChange, onWritingChange]);
  useEffect(() => {
    if (state.turnOperation) setPrompt(state.turnOperation.prompt);
  }, [state.turnOperation]);
  useEffect(() => {
    if (!isSending && recoveredChatId && attemptedRecovery.current !== creationId) {
      void recoverChat();
    }
  }, [isSending, creationId, recoveredChatId, recoverChat]);
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
    let chatId = state.chatId;
    let preparingChat = false;
    try {
      // Persist identity and exact input before sending either request. A lost
      // settings acknowledgement stops here; reload reads the committed identity.
      let creation = state.createChatOperation ?? {
        operationId: crypto.randomUUID(),
        title: prompt.slice(0, 60),
      };
      let turn = state.turnOperation ?? { operationId: crypto.randomUUID(), prompt };
      const prepared: { destination?: OnboardingState } = {};
      onWritingChange(true);
      try {
        await onChange((current) => {
          if (
            !current.workdir ||
            (state.chatId && current.chatId !== state.chatId) ||
            (creationId && current.createChatOperation?.operationId !== creationId) ||
            (state.turnOperation &&
              current.turnOperation?.operationId !== state.turnOperation.operationId)
          ) {
            return current;
          }
          // Another tab may have stored the request since this render.
          creation = current.createChatOperation ?? creation;
          turn = current.turnOperation ?? turn;
          chatId = current.chatId;
          prepared.destination = current;
          pendingOperationId = turn.operationId;
          pendingCreationId = creation.operationId;
          return {
            ...current,
            requiresTurnReceipt: true,
            createChatOperation: creation,
            turnOperation: turn,
          };
        });
        if (!prepared.destination) return;
        if (!chatId) {
          preparingChat = true;
          const chat = await createChat.mutateAsync(creation);
          preparingChat = false;
          let matchesAttempt = false;
          await onChange((current) => {
            matchesAttempt =
              current.createChatOperation?.operationId === creation.operationId &&
              current.turnOperation?.operationId === turn.operationId &&
              (!current.chatId || current.chatId === chat.id);
            if (!matchesAttempt) return current;
            prepared.destination = current;
            return current.chatId === chat.id ? current : { ...current, chatId: chat.id };
          });
          if (!matchesAttempt) return;
          chatId = chat.id;
        }
      } finally {
        onWritingChange(false);
      }

      if (!prepared.destination.workdir) return;
      const { workdir, runner, environmentId } = prepared.destination;
      preparingChat = true;
      await updateChat.mutateAsync({
        id: chatId,
        updates: {
          environmentId: environmentId ?? LOCAL_ENVIRONMENT_ID,
          workdir,
          ...(runner ? { runner } : {}),
        },
      });
      preparingChat = false;
      const sendChatId = chatId;
      await sendWithExternalConsent(sendChatId, async () => {
        const receipt = await submitOperation({
          chatId: sendChatId,
          prompt: turn.prompt,
          operationId: turn.operationId,
        });
        const queryKey = ['product-operation', turn.operationId];
        // A lookup sent before admission may still be returning a 404.
        await queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.setQueryData<OperationReceipt | null>(queryKey, (current) => {
          if (current && current.state !== 'accepted' && current.state !== 'running')
            return current;
          if (current?.state === 'running' && receipt.state === 'accepted') return current;
          return receipt;
        });
      });
    } catch (error) {
      if (
        preparingChat &&
        error instanceof ApiError &&
        (error.code === ERROR_CODES.NOT_FOUND ||
          (!chatId && error.code === ERROR_CODES.OPERATION_EXPIRED))
      ) {
        setUnavailableChat({ chatId, creationId: pendingCreationId });
      } else {
        setFailed(true);
      }
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

  const busy = receipt?.state === 'accepted' || receipt?.state === 'running';
  const expired =
    operation.error instanceof ApiError && operation.error.code === ERROR_CODES.OPERATION_EXPIRED;
  const canStartNewRequest =
    !answered &&
    (chatUnavailable ||
      (receipt?.state !== 'completed' &&
        (expired || receipt?.state === 'failed' || receipt?.state === 'unresolved')));
  const newRequest = async () => {
    if (!canStartNewRequest || sending.current) return;
    const operationId = state.chatId ? state.turnOperation?.operationId : creationId;
    onWritingChange(true);
    try {
      await onChange((current) => {
        const currentId = current.chatId
          ? current.turnOperation?.operationId
          : current.createChatOperation?.operationId;
        if (currentId !== operationId) return current;
        if (chatUnavailable) {
          if (
            current.chatId !== state.chatId ||
            current.createChatOperation?.operationId !== creationId
          )
            return current;
          return {
            ...current,
            chatId: undefined,
            createChatOperation: undefined,
            turnOperation: undefined,
            requiresTurnReceipt: true,
          };
        }
        return {
          ...current,
          turnOperation: undefined,
          requiresTurnReceipt: true,
          ...(!current.chatId ? { createChatOperation: undefined } : {}),
        };
      });
    } catch {
      setFailed(true);
    } finally {
      onWritingChange(false);
    }
  };
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
            chatUnavailable ||
            operation.isError ||
            isSending ||
            isRecovering
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
        {state.chatId && !chatUnavailable ? (
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

      {chatUnavailable ? <Callout tone="warning">{s.chatUnavailable}</Callout> : null}
      {receipt && !expired && !chatUnavailable ? (
        <Callout
          tone={receipt.state === 'failed' || receipt.state === 'unresolved' ? 'warning' : 'info'}
          data-testid="onboarding-operation-state"
        >
          {busy ? <Spinner size="sm" /> : null}
          {s.operationStates[receipt.state]}
        </Callout>
      ) : null}
      {expired && !chatUnavailable ? <Callout tone="warning">{s.operationExpired}</Callout> : null}
      {operation.isError && !expired && !chatUnavailable ? (
        <Callout
          tone="warning"
          action={
            <Button
              variant="secondary"
              size="sm"
              data-testid="onboarding-retry-status"
              loading={operation.isFetching}
              onClick={() => void operation.refetch()}
            >
              {s.retryStatus}
            </Button>
          }
        >
          {s.operationUnavailable}
        </Callout>
      ) : null}
      {recoveredChatId && failedRecovery === creationId ? (
        <Callout
          tone="warning"
          action={
            <Button
              variant="secondary"
              size="sm"
              data-testid="onboarding-retry-recovery"
              onClick={() => void recoverChat()}
            >
              {s.retryRecovery}
            </Button>
          }
        >
          {s.recoveryFailed}
        </Callout>
      ) : null}
      {canStartNewRequest ? (
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
