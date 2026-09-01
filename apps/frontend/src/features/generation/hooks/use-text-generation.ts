/* global console */

import type { Message, MessagePart, ReasoningEffort } from '@mangostudio/shared';
import { isAgentId } from '@mangostudio/shared/agents';
import type { ChatTitleSettings } from '@mangostudio/shared/app-settings';
import {
  type ContextCompactionResponse,
  type ContextSettings,
  createPromptChatTitle,
  type ExternalAgentTargetId,
  isTimestampChatTitle,
} from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ExternalReviewTarget } from '@mangostudio/shared/external-agents';
import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import type {
  ExternalTurnRequest,
  ModelUnavailableDetails,
  RespondStreamBody,
  ToolIntent,
} from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { invalidateChatFileCheckpoints } from '@/features/chat/hooks/use-chat-file-checkpoints';
import { useChatStream } from '@/features/chat/hooks/use-chat-stream';
import { setChatTodos } from '@/features/chat/hooks/use-chat-todos';
import type { useChats } from '@/features/chat/hooks/use-chats';
import { chatKeys, messageKeys } from '@/features/chat/queries';
import { generateChatTitleSuggestion } from '@/features/chat/services/chat-title';
import { compactChat, summarizeToNewChat } from '@/features/chat/services/context-compaction';
import { publishExternalCommands } from '@/features/external-agents/command-catalog';
import {
  type ExternalDisclosureRequest,
  promptExternalDisclosure,
} from '@/features/external-agents/disclosure-prompt';
import {
  publishExternalAccountLimits,
  publishExternalCommandCatalog,
} from '@/features/external-agents/queries';
import { promptExternalWorkspaceTrust } from '@/features/external-agents/workspace-trust-prompt';
import type { useOptimisticMessages } from '@/features/generation/hooks/use-optimistic-messages';
import {
  createTextGenerationStreamState,
  reduceTextGenerationStreamChunk,
  settleUnfinishedImageParts,
  type TextGenerationStreamMessageUpdate,
} from '@/features/generation/text-generation-stream-reducer';
import { invalidateGitState } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import {
  cancelInterruptedTurn,
  dismissInterruptedTurn,
  respondTextStream,
  startExternalReviewStream,
} from '@/services/generation-service';

/**
 * Runs a send, and gives each answerable refusal one chance to be answered.
 *
 * Both refusals are decided before any of the stream exists — the server answers
 * 403 rather than opening one — so a retry here re-sends a turn that never
 * started rather than resuming one that half did. Exactly one retry per
 * refusal: a second one after the answer was recorded is a real failure, and
 * looping on it would hide it behind a dialog the user keeps answering.
 *
 * The two are checked in sequence rather than in a loop, so a send cannot bounce
 * between them. A turn refused for a workspace and then for a disclosure is a
 * turn that asks the user two separate questions, which is the honest cost of
 * two independent consents; a turn refused twice for the same one is a failure
 * and surfaces as one.
 */
async function sendWithExternalConsent(chatId: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    const answered = await answerExternalRefusal(chatId, error);
    if (!answered) throw error;
    try {
      await send();
    } catch (retryError) {
      // The *other* consent, asked once. Reaching here means the first answer
      // was recorded and accepted, and the server then refused for a different
      // reason — a second question, not the same one again.
      const secondAnswer = await answerExternalRefusal(chatId, retryError, answered);
      if (!secondAnswer) throw retryError;
      await send();
    }
  }
}

/**
 * Raises whichever consent dialog this refusal calls for.
 *
 * Returns the kind that was answered, or `undefined` when the error is not an
 * answerable refusal, is the kind already answered on this send, or when the
 * user declined.
 */
async function answerExternalRefusal(
  chatId: string,
  error: unknown,
  already?: 'workspace' | 'disclosure'
): Promise<'workspace' | 'disclosure' | undefined> {
  const scope = untrustedWorkspaceScope(error);
  if (scope && already !== 'workspace') {
    return (await promptExternalWorkspaceTrust({ chatId, ...scope })) ? 'workspace' : undefined;
  }
  const disclosure = requiredDisclosureScope(error);
  if (disclosure && already !== 'disclosure') {
    return (await promptExternalDisclosure(disclosure)) ? 'disclosure' : undefined;
  }
  return undefined;
}

/**
 * The deprecated-provider refusal, or `undefined` for any other failure.
 *
 * Read off the typed details rather than the server's sentence: the reason is
 * what decides whether a fork is on offer at all, and the message is prose
 * written for a log. `reason` is checked as well as the code so a future
 * refusal that reuses the code cannot render Cursor's copy.
 */
function deprecatedProviderRefusal(error: unknown): ModelUnavailableDetails | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code !== ERROR_CODES.MODEL_PROVIDER_DEPRECATED) return undefined;
  const details = error.details as Partial<ModelUnavailableDetails> | undefined;
  if (details?.reason !== 'provider-deprecated' || !details.action) return undefined;
  return { ...details, reason: 'provider-deprecated', action: details.action };
}

/**
 * The vendor and machine a disclosure refusal named.
 *
 * Both fields or neither: the acknowledgement is stored per vendor and per
 * machine, so a partial scope could only be recorded partially. The chat's own
 * environment is deliberately not used as a fallback — it can differ from the
 * one the refused turn resolved against, and acknowledging the wrong machine
 * would leave the send refused with a consent recorded that nobody asked for.
 */
function requiredDisclosureScope(error: unknown): ExternalDisclosureRequest | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code !== ERROR_CODES.EXTERNAL_DISCLOSURE_REQUIRED) return undefined;
  const { targetId, environmentId } = error.details ?? {};
  if (!targetId || !environmentId || !isExternalAgentTargetId(targetId)) return undefined;
  return { targetId, environmentId };
}

/**
 * The scope a refusal named, or `undefined` when it was some other failure.
 *
 * All three fields or none: the grant is checked against the scope this
 * disclosed, and a partial one could only be checked partially.
 */
function untrustedWorkspaceScope(error: unknown):
  | {
      readonly workspacePath: string;
      readonly targetId: string;
      readonly environmentId: string;
    }
  | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code !== ERROR_CODES.EXTERNAL_WORKSPACE_UNTRUSTED) return undefined;
  const { workspacePath, targetId, environmentId } = error.details ?? {};
  if (!workspacePath || !targetId || !environmentId) return undefined;
  return { workspacePath, targetId, environmentId };
}

interface UseTextGenerationOptions {
  chats: ReturnType<typeof useChats>;
  getActiveModel: () => string;
  systemPrompt: string;
  promptSettings?: PromptSettings;
  optimistic: ReturnType<typeof useOptimisticMessages>;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxToolIterations: number;
  contextSettings: ContextSettings;
  chatTitleSettings: ChatTitleSettings;
  currentChatId: string | null;
  getAgentSelection: () => {
    readonly agentId: string;
    readonly agentName?: string;
  };
  /** The vendor model and effort the composer chose, read at send time. */
  getExternalTurnRequest?: () => ExternalTurnRequest | undefined;
  /**
   * The vendor this turn runs on, when the chat's runner is external.
   *
   * Separate from `getExternalTurnRequest`, which is absent whenever the user
   * left both vendor options alone — an external turn on the vendor's own
   * defaults is still external, so the runner is what decides that.
   */
  getExternalRunnerTargetId?: () => ExternalAgentTargetId | undefined;
  /**
   * Waits out a runner write the composer may have just started.
   *
   * The hub dispatches on the runner it has stored, so this has to settle
   * before the stream opens — otherwise a send that follows the picker closely
   * enough runs on the runner the user just replaced, whatever the composer
   * shows. Resolves immediately when no write is open, which is every send but
   * the one right after a switch.
   */
  whenRunnerPersisted?: () => Promise<void>;
  /**
   * Applies the selection the empty state was holding — runner and default
   * workdir — to a chat auto-created by this turn. Awaited before the stream
   * opens so the first turn resolves against the same configuration every
   * later turn will, and its return value (not `getAgentSelection`) is what
   * that first turn runs as.
   */
  onChatCreated?: (chatId: string) => Promise<{
    readonly agentId: string;
    readonly agentName?: string;
  }>;
}

type RecoveryRequest = NonNullable<RespondStreamBody['recovery']>;

/**
 * One turn, however it was started.
 *
 * `review` is what makes this an options object rather than four positional
 * arguments: a review carries no prompt the user wrote, no attachments and no
 * MangoStudio model, but everything after the request — optimistic messages,
 * the reducer, cancellation, error handling, invalidation — is identical, and
 * a second copy of that is a second place for it to drift.
 */
interface RunTurnOptions {
  readonly prompt: string;
  readonly toolIntent?: ToolIntent;
  readonly attachmentIds?: string[];
  readonly recovery?: RecoveryRequest;
  readonly review?: ExternalReviewTarget;
}

function resolveSummaryModelId(settings: ContextSettings, currentModel: string): string {
  return settings.preferredSummaryModel === 'current_model'
    ? currentModel
    : settings.preferredSummaryModel;
}

function shouldRenameChatFromPrompt(
  chatTitleSettings: ChatTitleSettings,
  currentTitle: string | undefined,
  createdChatDuringRequest: boolean
): boolean {
  if (!chatTitleSettings.autoRenameEnabled) return false;
  if (createdChatDuringRequest) return true;
  return currentTitle !== undefined && isTimestampChatTitle(currentTitle);
}

function resolveChatTitleModel(settings: ChatTitleSettings, currentModel: string): string {
  return settings.preferredModel === 'current_model' ? currentModel : settings.preferredModel;
}

async function createAutoChatTitle(
  prompt: string,
  chatTitleSettings: ChatTitleSettings,
  currentModel: string
): Promise<string | null> {
  const fallbackTitle = createPromptChatTitle(prompt, chatTitleSettings.promptPrefixLength);
  if (!fallbackTitle || chatTitleSettings.strategy === 'prompt_prefix') return fallbackTitle;

  try {
    const response = await generateChatTitleSuggestion({
      prompt,
      model: resolveChatTitleModel(chatTitleSettings, currentModel),
    });
    return response.title;
  } catch {
    return fallbackTitle;
  }
}

async function renameChatFromPrompt({
  chats,
  chatId,
  prompt,
  chatTitleSettings,
  currentModel,
}: {
  chats: ReturnType<typeof useChats>;
  chatId: string;
  prompt: string;
  chatTitleSettings: ChatTitleSettings;
  currentModel: string;
}): Promise<void> {
  const promptTitle = await createAutoChatTitle(prompt, chatTitleSettings, currentModel);
  if (promptTitle) {
    await chats.updateChatTitle(chatId, promptTitle);
  }
}

function startChatAutoRename(input: Parameters<typeof renameChatFromPrompt>[0]): void {
  void renameChatFromPrompt(input).catch((error: unknown) => {
    console.warn('[chat-title] Failed to auto rename chat', error);
  });
}

function applyStreamMessageUpdate(
  chatId: string,
  update: TextGenerationStreamMessageUpdate | null,
  updateOptimisticMessage: UseTextGenerationOptions['optimistic']['updateOptimisticMessage']
) {
  if (!update) return;
  updateOptimisticMessage(chatId, update.targetMessageId, update.patch);
}

/** Handles text generation: creates messages, drives SSE stream, updates optimistic UI. */
export function useTextGeneration({
  chats,
  getActiveModel,
  systemPrompt,
  promptSettings,
  optimistic,
  thinkingEnabled,
  reasoningEffort,
  maxToolIterations,
  contextSettings,
  chatTitleSettings,
  currentChatId,
  getAgentSelection,
  getExternalTurnRequest,
  getExternalRunnerTargetId,
  whenRunnerPersisted,
  onChatCreated,
}: UseTextGenerationOptions) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const pendingSubagentName = t.chat.feed.subagentPendingName;
  const stream = useChatStream({ currentChatId });
  const { appendOptimisticMessages, updateOptimisticMessage } = optimistic;
  const activeTurnRef = useRef<{ readonly chatId: string; readonly messageId: string } | null>(
    null
  );
  /** The turn a stop has already been handed to the server for — see `handleStop`. */
  const stopRequestedRef = useRef<string | null>(null);
  const [pendingContextAction, setPendingContextAction] = useState<'compact' | 'new-chat' | null>(
    null
  );
  /**
   * The last deprecated-provider refusal, held so the composer can offer the
   * migration. Keyed by the chat that was refused: this hook lives on the
   * authenticated layout, and a bare details object would follow the user into
   * the next chat they open. Cleared when a turn starts rather than when one
   * succeeds: the next send is the user acting on the notice, and leaving it up
   * underneath a running turn would show a refusal that no longer applies.
   */
  const [modelUnavailable, setModelUnavailable] = useState<{
    chatId: string;
    details: ModelUnavailableDetails;
  } | null>(null);

  const syncContextInfo = useCallback(
    (response: ContextCompactionResponse) => {
      if (response.contextInfo) {
        stream.seedContextInfo(response.chatId, response.contextInfo);
      }
    },
    [stream]
  );

  const refreshChatState = useCallback(
    async (chatId: string) => {
      await Promise.all([
        chats.loadChats(),
        queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) }),
      ]);
    },
    [chats, queryClient]
  );

  const runTurn = useCallback(
    async ({ prompt, toolIntent, attachmentIds, recovery, review }: RunTurnOptions) => {
      if (stream.abortControllerRef.current) return;
      setModelUnavailable(null);
      stream.setIsGenerating(true);

      let activeChatId = chats.currentChatId;
      let createdChatDuringRequest = false;
      let activeChatTitle = chats.currentChat?.title;
      // Read alongside the title, and for the same reason: a chat created by
      // this send is not in `chats` yet, and the machine a quota snapshot
      // belongs to is part of the key it is cached under.
      let activeEnvironmentId = chats.currentChat?.environmentId ?? null;
      let boundAgentSelection: { agentId: string; agentName?: string } | null = null;
      if (!activeChatId) {
        const newChat = await chats.createChat();
        activeChatId = newChat.id;
        activeChatTitle = newChat.title;
        activeEnvironmentId = newChat.environmentId ?? null;
        createdChatDuringRequest = true;
        boundAgentSelection = (await onChatCreated?.(newChat.id)) ?? null;
      }

      const model = getActiveModel();
      const externalTargetId = getExternalRunnerTargetId?.();
      // Read once: the request body below sends the same value, and the two
      // must describe one turn.
      const externalTurnRequest = getExternalTurnRequest?.();
      // What the turn header names while the turn streams. MangoStudio does not
      // run an external turn, so its own model must not be reported for one, and
      // the vendor itself is the only name available until the user picks a
      // model.
      //
      // Approximate on purpose, and known to be: the hub persists
      // `configuration.model ?? target`, where `configuration.model` is the
      // catalog default the *adapter* resolved when the request named none. The
      // bare target id agrees either way — the header renders it as the vendor's
      // name — but a vendor that advertises a catalog makes this read as the
      // vendor live and as a model id once the stored record replaces it.
      // Closing that gap needs the effective model on the wire: the hub knows
      // it, the `external_session_started` chunk does not carry it yet (see
      // issue #816).
      const displayModel = externalTargetId
        ? (externalTurnRequest?.model ?? externalTargetId)
        : model;
      const agentSelection = boundAgentSelection ?? getAgentSelection();

      // A review's prompt is the button's own label, the same words every time.
      // Renaming a chat to it would replace a timestamp with something even
      // less descriptive.
      if (
        !recovery &&
        !review &&
        shouldRenameChatFromPrompt(chatTitleSettings, activeChatTitle, createdChatDuringRequest)
      ) {
        startChatAutoRename({
          chats,
          chatId: activeChatId,
          prompt,
          chatTitleSettings,
          currentModel: model,
        });
      }

      const optimisticUserMsgId = `optimistic-user-${crypto.randomUUID()}`;
      const optimisticAiMsgId = `optimistic-ai-${crypto.randomUUID()}`;

      const optimisticUserMsg: Message = {
        id: optimisticUserMsgId,
        chatId: activeChatId,
        role: 'user',
        text: prompt,
        timestamp: Date.now(),
        interactionMode: 'agent',
        agentId: agentSelection.agentId,
        agentName: agentSelection.agentName,
      };

      const optimisticAiMsg: Message = {
        id: optimisticAiMsgId,
        chatId: activeChatId,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: true,
        modelName: displayModel,
        interactionMode: 'agent',
        agentId: agentSelection.agentId,
        agentName: agentSelection.agentName,
      };

      appendOptimisticMessages(activeChatId, [optimisticUserMsg, optimisticAiMsg]);

      const controller = new AbortController();
      stream.setAbortController(controller);
      let streamState = createTextGenerationStreamState({
        userMessageId: optimisticUserMsgId,
        aiMessageId: optimisticAiMsgId,
      });

      try {
        // Late on purpose. The turn is dispatched on the runner the hub has
        // stored, so an optimistic switch has to be answered before the stream
        // opens — but the echo above and the abort controller are what make the
        // composer feel immediate, and a stop pressed during this wait still
        // lands because the controller is already registered.
        await whenRunnerPersisted?.();

        await sendWithExternalConsent(activeChatId, () => {
          const onChunk = (chunk: StreamChunk) => {
            streamState = reduceTextGenerationStreamChunk(streamState, chunk, {
              pendingSubagentName,
            });
            applyStreamMessageUpdate(
              activeChatId,
              streamState.userMessageUpdate,
              updateOptimisticMessage
            );
            applyStreamMessageUpdate(
              activeChatId,
              streamState.aiMessageUpdate,
              updateOptimisticMessage
            );

            if (chunk.type === 'assistant_message_id') {
              activeTurnRef.current = { chatId: activeChatId, messageId: chunk.messageId };
              if (recovery) {
                void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId) });
              }
            }

            if (chunk.type === 'context_info') {
              stream.updateContextInfo(activeChatId, {
                estimatedInputTokens: chunk.estimatedInputTokens,
                contextLimit: chunk.contextLimit,
                estimatedUsageRatio: chunk.estimatedUsageRatio,
                mode: chunk.mode,
                severity: chunk.severity,
              });
            }

            if (streamState.threadUsage) {
              stream.updateThreadUsage(activeChatId, streamState.threadUsage);
            }

            if (chunk.type === 'fallback_notice') {
              stream.setFallbackNotice({ from: chunk.from, to: chunk.to, reason: chunk.reason });
            }

            if (chunk.type === 'todo_update') {
              setChatTodos(queryClient, activeChatId, chunk.todos);
            }

            // The vendor's own quota reading, mid-turn — fresher than anything
            // the header could have read on mount, and the only free one: the
            // alternative is a probe on the user's machine. A review stream
            // shares this handler, so it lands there too.
            if (chunk.type === 'external_account_limits') {
              publishExternalAccountLimits(
                queryClient,
                activeEnvironmentId,
                chunk.limits,
                // The account the hub bound this turn to. Absent means the vendor
                // has none — not "look it up", which is how a reading from the
                // account the turn is running as ends up under another one.
                chunk.vendorAccountFingerprint ?? null
              );
            }

            // What this session will expand as `/name`. Filed against the chat
            // so the composer's palette can offer the vendor's own list rather
            // than a guess rebuilt from directories the CLI may not have read.
            //
            // Also filed against the hub-catalog key so the next chat opened
            // against this (environment, target) — not just this one — sees
            // it too, instead of whatever the first cold GET in the tab saw.
            if (chunk.type === 'external_commands') {
              publishExternalCommands(queryClient, activeChatId, chunk.commands);
              publishExternalCommandCatalog(
                queryClient,
                externalTargetId ?? null,
                activeEnvironmentId,
                chunk.commands
              );
            }
          };

          // One transport per kind of turn, one reducer for both. A review has
          // no prompt, no attachments and no MangoStudio model to name; what it
          // has is the same chunk vocabulary, which is why everything above this
          // line is shared.
          return review
            ? startExternalReviewStream(
                activeChatId,
                { target: review, displayPrompt: prompt },
                onChunk,
                controller.signal
              )
            : respondTextStream(
                {
                  chatId: activeChatId,
                  prompt,
                  attachmentIds,
                  model,
                  systemPrompt: systemPrompt || undefined,
                  promptSettings,
                  thinkingEnabled,
                  reasoningEffort,
                  maxToolIterations,
                  contextSettings,
                  toolIntent,
                  // Vendor ids, not MangoStudio's: a Codex model and one of that
                  // model's own efforts. Absent on an internal turn, where the
                  // closed `model`/`reasoningEffort` pair is the right vocabulary.
                  externalTurn: externalTurnRequest,
                  agentId: isAgentId(agentSelection.agentId) ? agentSelection.agentId : undefined,
                  recovery,
                },
                onChunk,
                controller.signal
              );
        });

        // A stream can close cleanly without ever having sealed the row.
        // `finalizeInterruptedTurn` ends a cancelled turn without yielding
        // `done` — and since Stop keeps reading, that is now its ordinary path —
        // so nothing throws and neither branch below runs. Left alone the row
        // keeps `isGenerating: true`, which `deriveTurnStatus` reads as
        // `working`: copy and revert stay hidden and a working row draws under
        // cards the stream already settled.
        if (!streamState.sealed) {
          updateOptimisticMessage(activeChatId, streamState.currentAiMessageId, {
            isGenerating: false,
            parts: settleUnfinishedImageParts(
              streamState.parts,
              t.errors.imageGenerationInterrupted
            ),
          });
        }
      } catch (error: unknown) {
        // Every end that reaches this catch is one a card at `generating` never
        // hears about — an abort, a dropped socket, a provider that threw. The
        // events that would settle it are in a stream nobody is reading any
        // more, so this is the last place to do it. Returns the same array when
        // nothing is pending, which is what keeps `parts` out of the update on
        // an ordinary stop.
        const settledParts = settleUnfinishedImageParts(
          streamState.parts,
          t.errors.imageGenerationInterrupted
        );
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          updateOptimisticMessage(activeChatId, streamState.currentAiMessageId, {
            isGenerating: false,
            ...(settledParts === streamState.parts ? {} : { parts: settledParts }),
          });
        } else {
          console.error('[respond]', error);
          // Surfaced above the composer as well as in the transcript: the
          // transcript says what happened, the notice is where the way out is.
          const deprecated = deprecatedProviderRefusal(error);
          if (deprecated) setModelUnavailable({ chatId: activeChatId, details: deprecated });
          const errorText = resolveApiErrorMessage(error, t.errors.textGenerationFailed);
          const alreadyHasError = settledParts.some((part) => part.type === 'error');
          const nextParts: MessagePart[] = alreadyHasError
            ? settledParts
            : [...settledParts, { type: 'error', text: errorText }];
          updateOptimisticMessage(activeChatId, streamState.currentAiMessageId, {
            isGenerating: false,
            text: streamState.text || errorText,
            parts: nextParts,
          });
        }
        // A review was started from a button in the repository panel, not from
        // the composer — its caller is looking at that panel, and needs the
        // refusal where it clicked as well as in the transcript.
        if (recovery || review) throw error;
      } finally {
        activeTurnRef.current = null;
        stopRequestedRef.current = null;
        stream.setAbortController(null);
        stream.setIsGenerating(false);
        // Realtime normally refreshes mounted Git panels; keep this as the
        // degradation path when the socket is unavailable or reconnecting.
        void invalidateGitState(queryClient, activeChatId);
        invalidateChatFileCheckpoints(queryClient, activeChatId);
        // Every turn moves the chat's `updatedAt`, and the sidebar buckets rows
        // by it — a resumed chat that is not re-read stays in yesterday's group
        // until a reload. Unconditional on purpose: it subsumes the chat this
        // turn created, and a turn that failed part-way may still have persisted
        // the user's message. The server's timestamp is the one that counts, so
        // this re-reads rather than bumping the cached row by hand.
        void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
        if (
          recovery ||
          !streamState.receivedServerUserMessageId ||
          !streamState.receivedServerAiMessageId
        ) {
          void queryClient.invalidateQueries({ queryKey: messageKeys.list(activeChatId) });
        }
      }
    },
    [
      chats,
      getActiveModel,
      systemPrompt,
      promptSettings,
      t,
      appendOptimisticMessages,
      updateOptimisticMessage,
      queryClient,
      thinkingEnabled,
      reasoningEffort,
      maxToolIterations,
      contextSettings,
      chatTitleSettings,
      getAgentSelection,
      getExternalTurnRequest,
      getExternalRunnerTargetId,
      whenRunnerPersisted,
      onChatCreated,
      stream,
      pendingSubagentName,
    ]
  );

  const handleRespond = useCallback(
    async (
      prompt: string,
      toolIntent?: ToolIntent,
      attachmentIds?: string[],
      recovery?: RecoveryRequest
    ) => {
      await runTurn({ prompt, toolIntent, attachmentIds, recovery });
    },
    [runTurn]
  );

  /**
   * The vendor's own review of the working tree, as an ordinary turn.
   *
   * Refused without a chat: a review needs a workspace, and a workspace lives on
   * a chat. Nothing is created here — an action that silently made a new chat to
   * review a folder it does not have yet would be a surprise, not a shortcut.
   */
  const handleReviewChanges = useCallback(async () => {
    if (!chats.currentChatId) return;
    await runTurn({
      prompt: t.externalAgents.review.userMessage,
      review: { type: 'uncommittedChanges' },
    });
  }, [chats.currentChatId, runTurn, t.externalAgents.review.userMessage]);

  const handleStop = useCallback(() => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn) {
      stream.handleStop();
      return;
    }

    // A second press on the same turn is the hard kill. The first hands the
    // stop to the server and waits for it to close the stream, which is what
    // lets the cancelled turn settle its own cards — but the server cannot
    // always end one promptly. An image already in flight with the provider
    // outlives the cancel, because `generateImage` is never given the signal,
    // and without this the user's only way out of that wait is a reload.
    if (stopRequestedRef.current === activeTurn.messageId) {
      stream.handleStop();
      return;
    }
    stopRequestedRef.current = activeTurn.messageId;

    // Captured, not read again in the handler below. That call settles whenever
    // the network lets it, by which time the ref may hold the controller of a
    // turn the user has since sent — `runTurn`'s `finally` clears it and the
    // next send installs its own. Aborting this one is a no-op if the stream it
    // belongs to has already ended, which is exactly the intent.
    const cancelledStream = stream.abortControllerRef.current;

    // Cancel, then keep reading. `/recovery/cancel` returns as soon as the turn
    // is told to stop, and a cancelled turn is not finished talking: the
    // `image_generation_failed` events for the images it never reached are what
    // move those cards off `generating`, and they are yielded after the cancel
    // call has already resolved. Aborting the fetch here dropped exactly those,
    // leaving the open tab pulsing until a reload. The server closes the stream
    // once the cancelled turn unwinds, and this request ends with it.
    void cancelInterruptedTurn(activeTurn.chatId, activeTurn.messageId).catch((error: unknown) => {
      console.warn('[turn-recovery] Failed to persist turn cancellation', error);
      // Nothing told the turn to stop, so nothing is going to close this
      // stream. Tearing the reader down is the only stop left.
      cancelledStream?.abort();
    });
  }, [stream]);

  const handleResumeInterruptedTurn = useCallback(
    async (messageId: string, retryCallIds: string[]) => {
      await handleRespond(t.chat.recovery.resumeUserMessage, undefined, undefined, {
        messageId,
        requestId: crypto.randomUUID(),
        retryCallIds,
      });
    },
    [handleRespond, t.chat.recovery.resumeUserMessage]
  );

  const handleDismissInterruptedTurn = useCallback(
    async (messageId: string) => {
      const chatId = chats.currentChatId;
      if (!chatId) return;
      await dismissInterruptedTurn(chatId, messageId);
      await queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) });
    },
    [chats.currentChatId, queryClient]
  );

  const handleCompactCurrentChat = useCallback(async () => {
    const chatId = chats.currentChatId;
    if (!chatId) throw new Error('No active chat available for compaction.');

    setPendingContextAction('compact');
    try {
      const response = await compactChat(chatId, {
        model: resolveSummaryModelId(contextSettings, getActiveModel()),
      });
      syncContextInfo(response);
      await refreshChatState(chatId);
    } finally {
      setPendingContextAction(null);
    }
  }, [chats.currentChatId, contextSettings, getActiveModel, refreshChatState, syncContextInfo]);

  const handleStartSummarizedChat = useCallback(async () => {
    const chatId = chats.currentChatId;
    if (!chatId) throw new Error('No active chat available for summary handoff.');

    setPendingContextAction('new-chat');
    try {
      const response = await summarizeToNewChat(chatId, {
        model: resolveSummaryModelId(contextSettings, getActiveModel()),
      });
      syncContextInfo(response);
      await chats.loadChats();
      chats.setCurrentChatId(response.chatId);
      await queryClient.invalidateQueries({ queryKey: messageKeys.list(response.chatId) });
    } finally {
      setPendingContextAction(null);
    }
  }, [chats, contextSettings, getActiveModel, queryClient, syncContextInfo]);

  return {
    isGenerating: stream.isGenerating,
    handleRespond,
    handleReviewChanges,
    handleCompactCurrentChat,
    handleStartSummarizedChat,
    handleStop,
    handleResumeInterruptedTurn,
    handleDismissInterruptedTurn,
    contextInfo: stream.contextInfo,
    threadUsage: stream.threadUsage,
    fallbackNotice: stream.fallbackNotice,
    seedContextInfo: stream.seedContextInfo,
    contextCache: stream.contextCache,
    isContextActionPending: pendingContextAction !== null,
    modelUnavailable:
      modelUnavailable !== null && modelUnavailable.chatId === currentChatId
        ? modelUnavailable.details
        : null,
    dismissModelUnavailable: useCallback(() => setModelUnavailable(null), []),
  };
}
