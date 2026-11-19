/**
 * SSE streaming route: thin transport adapter over stream-text-turn.
 * Responsible for pre-flight HTTP errors, SSE framing, heartbeats, abort handling,
 * and error serialization.
 */

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { type RespondStreamBody, RespondStreamBodySchema } from '@mangostudio/shared/generation';
import { OperationIdSchema, OperationReceiptSchema } from '@mangostudio/shared/operations';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';
import { type Elysia, t } from 'elysia';

import { getDb } from '../../../db/database';
import { type ApiErrorStatus, apiErrorStatus } from '../../../lib/api-error-status';
import { environmentUnavailableBody } from '../../../lib/environment-unavailable';
import { getErrorCode } from '../../../lib/error-code';
import { SSE_KEEPALIVE_FRAME, SSE_KEEPALIVE_INTERVAL_MS } from '../../../lib/hub-connection-limits';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import { AgentSettingsError } from '../../agents/domain/agent-profile';
import {
  assertChatAttachmentIdsAvailable,
  ChatAttachmentNotFoundError,
} from '../../attachments/infrastructure/attachment-repository';
import { getOwnedChat, type OwnedChatRecord } from '../../chats/infrastructure/chat-repository';
import { streamExternalTurn } from '../../external-agents/application/external-turn-stream';
import {
  EXTERNAL_PREFLIGHT_CODE,
  EXTERNAL_PREFLIGHT_STATUS,
  externalPreflightDetails,
} from '../../external-agents/http/external-preflight';
import { drainOperationStream } from '../../operations/application/drain-operation-stream';
import {
  claimOperation,
  finishOperation,
  OperationConflictError,
  OperationExpiredError,
  operationReceipt,
  readOperation,
  releaseOperation,
  settleOperation,
} from '../../operations/application/product-operation';
import { trackProductOperationWork } from '../../operations/application/product-operation-work';
import { registerActiveTurn } from '../application/active-turn-registry';
import {
  NoModelAvailableError,
  type ResolvedModel,
  resolveModel,
} from '../application/resolve-model';
import {
  type ResolvedRunnerAgent,
  resolveRunnerAgentProfile,
} from '../application/resolve-runner-agent';
import { streamTextTurn } from '../application/stream-text-turn';
import {
  assertTextTurnHasContent,
  EmptyTextTurnError,
  normalizeTextTurnAttachmentIds,
} from '../application/text-turn-content';
import {
  inspectInterruptedTurnResume,
  reserveInterruptedTurnResume,
  TurnRecoveryConflictError,
  TurnRecoveryNotFoundError,
  TurnRecoveryValidationError,
} from '../application/turn-recovery';
import { modelUnavailableResponse } from './model-unavailable-response';
import { sseEvent, toSsePayload } from './turn-sse-events';

/**
 * The refusal a turn-recovery failure answers with, or `undefined` for an error
 * that is not one of the three recovery refusals (the caller rethrows it).
 * Inspecting and reserving a resume refuse for the same reasons, so both
 * pre-flight catch blocks share this mapping.
 */
function turnRecoveryRefusal(err: unknown): ApiErrorStatus<400 | 404 | 409> | undefined {
  if (err instanceof TurnRecoveryNotFoundError) {
    return apiErrorStatus(404, { error: err.message, code: ERROR_CODES.NOT_FOUND });
  }
  if (err instanceof TurnRecoveryConflictError) {
    return apiErrorStatus(409, { error: err.message, code: ERROR_CODES.CONFLICT });
  }
  if (err instanceof TurnRecoveryValidationError) {
    return apiErrorStatus(400, { error: err.message, code: ERROR_CODES.VALIDATION });
  }
  return undefined;
}

async function respondStream(
  body: RespondStreamBody,
  userId: string,
  admission?: { chat: OwnedChatRecord; onUserCancelled: () => void }
) {
  const db = getDb();

  // Every refusal before the stream starts is `status(code, body)`, never a
  // `Response`: the keyed wrapper below tells a refused preflight (release the
  // key, retryable) from an accepted stream by `instanceof Response`.

  // Ownership check must be pre-flight to return HTTP 404 before SSE
  // headers flush. The same read supplies the persisted runner, which
  // names the agent when the request does not.
  const ownedChat = admission?.chat ?? (await getOwnedChat(body.chatId, userId, db));
  if (!ownedChat) {
    return apiErrorStatus(404, { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
  }

  const attachmentIds = normalizeTextTurnAttachmentIds(body.attachmentIds);
  try {
    assertTextTurnHasContent(body.prompt, attachmentIds);
    await assertChatAttachmentIdsAvailable({ attachmentIds, userId, chatId: body.chatId }, db);
  } catch (err) {
    if (err instanceof ChatAttachmentNotFoundError || err instanceof EmptyTextTurnError) {
      return apiErrorStatus(400, { error: err.message, code: ERROR_CODES.VALIDATION });
    }
    throw err;
  }

  // Before the model, agent and provider preflight below, not after. An
  // external turn resolves no MangoStudio model, so running that first
  // answers a chat that needs no model with `NoModelAvailableError` —
  // a 503 about a provider the user never chose.
  if (ownedChat.runner.kind === 'external') {
    const result = await streamExternalTurn(
      {
        userId,
        chat: ownedChat,
        keyed: Boolean(admission),
        chatId: body.chatId,
        prompt: body.prompt,
        attachmentIds,
        externalTurn: body.externalTurn,
      },
      db
    );
    if (result.ok) return result.response;
    return apiErrorStatus(EXTERNAL_PREFLIGHT_STATUS[result.failure.kind], {
      error: result.failure.message,
      code: EXTERNAL_PREFLIGHT_CODE[result.failure.kind],
      // The disclosure has to name what gets loaded, and only the
      // machine that runs the vendor can spell the directory it will
      // read. The client renders this; it never composes one. The
      // vendor and machine travel with it so the grant that follows can
      // be checked against the scope this refusal disclosed — and the
      // acknowledgement is recorded against a specific machine's
      // descriptor, so a client that only learned "a disclosure is
      // required" could not record one.
      ...externalPreflightDetails(result.failure),
    });
  }

  let inspectedRecovery: Awaited<ReturnType<typeof inspectInterruptedTurnResume>> | null = null;
  if (body.recovery) {
    try {
      inspectedRecovery = await inspectInterruptedTurnResume(
        { chatId: body.chatId, userId, recovery: body.recovery },
        db
      );
    } catch (err) {
      const refusal = turnRecoveryRefusal(err);
      if (refusal) return refusal;
      throw err;
    }
  }

  // Model resolution must be pre-flight to return HTTP 503 before SSE headers flush.
  let resolvedModel: ResolvedModel;
  let resolvedAgent: ResolvedRunnerAgent;
  try {
    resolvedAgent = await resolveRunnerAgentProfile({
      db,
      userId,
      runner: ownedChat.runner,
      agentId: inspectedRecovery?.agentId ?? body.agentId,
    });
    resolvedModel = await resolveModel({
      requestedModel: inspectedRecovery?.modelName ?? body.model ?? resolvedAgent.profile.model,
      userId,
      type: 'text',
    });
  } catch (err) {
    if (err instanceof AgentSettingsError && err.status === 404) {
      return apiErrorStatus(404, { error: 'Agent not found', code: ERROR_CODES.NOT_FOUND });
    }
    if (err instanceof NoModelAvailableError) {
      const refusal = modelUnavailableResponse(err);
      return apiErrorStatus(refusal.status, refusal.body);
    }
    throw err;
  }

  // Provider lookup must be pre-flight to return HTTP 400 before SSE headers flush.
  try {
    if (resolvedModel.providerType) {
      getProvider(resolvedModel.providerType);
    } else {
      await getProviderForModel(resolvedModel.modelId, userId);
    }
  } catch {
    return apiErrorStatus(400, {
      error: 'No provider available for the requested model.',
      code: ERROR_CODES.PROVIDER_ERROR,
    });
  }

  const abortController = new AbortController();
  let registeredTurn: { readonly messageId: string; readonly release: () => void } | null = null;
  const registerTurn = (messageId: string) => {
    // A recovery resume registers when it reserves its rows, and streamTextTurn
    // then announces the same prepared turn again.
    if (registeredTurn?.messageId === messageId) return;
    registeredTurn = {
      messageId,
      release: registerActiveTurn(messageId, {
        userId,
        chatId: body.chatId,
        abort: (reasonCode) => abortController.abort(reasonCode),
      }),
    };
  };
  const unregisterTurn = () => {
    registeredTurn?.release();
    registeredTurn = null;
  };

  let reservedRecovery: Awaited<ReturnType<typeof reserveInterruptedTurnResume>> | null = null;
  if (body.recovery && inspectedRecovery) {
    try {
      reservedRecovery = await reserveInterruptedTurnResume(
        {
          chatId: body.chatId,
          userId,
          displayPrompt: body.prompt,
          attachmentIds,
          recovery: body.recovery,
          inspected: inspectedRecovery,
          resolvedModel,
          agentId: resolvedAgent.agentId,
          agentName: resolvedAgent.profile.name,
          onTurnReserved: registerTurn,
        },
        db
      );
    } catch (err) {
      unregisterTurn();
      const refusal = turnRecoveryRefusal(err);
      if (refusal) return refusal;
      throw err;
    }
  }

  // `abortController.signal.aborted` also goes true for an in-place Stop
  // (`cancelActiveTurn` aborts the same signal from a separate request),
  // which leaves this connection open and its controller writable. Only
  // the ReadableStream's own `cancel()` means the browser is gone and
  // `controller.enqueue` would throw, so trailing events a cancelled
  // turn still yields — like `image_generation_failed` for the images it
  // never reached — must gate on this instead of the abort signal.
  let clientDisconnected = false;

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(SSE_KEEPALIVE_FRAME);
        } catch {
          // Controller may already be closed
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      try {
        for await (const event of streamTextTurn(
          {
            chatId: body.chatId,
            userId,
            admittedChat: admission?.chat,
            onUserCancelled: admission?.onUserCancelled,
            prompt: reservedRecovery?.effectivePrompt ?? body.prompt,
            attachmentIds,
            model: resolvedModel.modelId,
            systemPrompt: body.systemPrompt,
            promptSettings: body.promptSettings,
            thinkingEnabled: body.thinkingEnabled ?? body.thinkingVisibility !== 'off',
            reasoningEffort: body.reasoningEffort,
            maxToolIterations: body.maxToolIterations,
            contextSettings: body.contextSettings,
            toolIntent: body.toolIntent,
            agentId: resolvedAgent.agentId,
            resolvedAgentProfile: resolvedAgent.profile,
            signal: abortController.signal,
            resolvedModel,
            preparedTurn: reservedRecovery
              ? {
                  userMessageId: reservedRecovery.userMessageId,
                  assistantMessageId: reservedRecovery.assistantMessageId,
                  checkpoint: reservedRecovery.checkpoint,
                }
              : undefined,
            onTurnPrepared: registerTurn,
          },
          db
        )) {
          if (!clientDisconnected) {
            controller.enqueue(sseEvent(toSsePayload(event)));
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          // A connect failure carries the same fixed text and code the JSON routes
          // answer 503 with, not the manager's diagnostic (paths, usernames).
          const unavailable = environmentUnavailableBody(err);
          const message =
            unavailable?.error ?? (err instanceof Error ? err.message : 'Stream generation failed');
          const code = unavailable?.code ?? getErrorCode(err);
          const errorEvent: SSEErrorEvent = {
            type: 'error',
            error: message,
            ...(code ? { code } : {}),
            done: true,
          };
          controller.enqueue(sseEvent(errorEvent));
        }
      } finally {
        clearInterval(heartbeat);
        unregisterTurn();
        try {
          controller.close();
        } catch {
          // The browser may already have cancelled the stream.
        }
      }
    },
    cancel() {
      clientDisconnected = true;
      abortController.abort('client_disconnect');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export const respondStreamRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      .get(
        '/operations/:operationId',
        {
          params: t.Object({ operationId: OperationIdSchema }),
          response: {
            200: OperationReceiptSchema,
            401: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            410: ApiErrorResponseSchema,
          },
        },
        async ({ params, user }) => {
          try {
            const row = await readOperation(getDb(), user?.id ?? '', params.operationId, {
              requireOwnedChat: true,
            });
            if (!row) {
              return apiErrorStatus(404, {
                error: 'Operation not found',
                code: ERROR_CODES.NOT_FOUND,
              });
            }
            return operationReceipt(row);
          } catch (error) {
            if (error instanceof OperationExpiredError) {
              return apiErrorStatus(410, {
                error: error.message,
                code: ERROR_CODES.OPERATION_EXPIRED,
              });
            }
            throw error;
          }
        }
      )
      .post('/respond/stream', { body: RespondStreamBodySchema }, async ({ body, user }) => {
        const userId = user?.id ?? '';
        if (!body.operationId) return respondStream(body, userId);
        const db = getDb();
        // Authorize before observing any receipt, including a replay.
        const chat = await getOwnedChat(body.chatId, userId, db);
        if (!chat) {
          return apiErrorStatus(404, { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
        }
        const operationId = body.operationId;
        try {
          const { row, claimed } = await claimOperation(
            db,
            userId,
            operationId,
            'submit-turn',
            {
              request: { ...body, operationId: undefined },
              runner: chat.runner,
              environmentId: chat.environmentId,
              workdir: chat.workdir,
              restrictToolsToWorkdir: chat.restrictToolsToWorkdir,
              permissions: chat.runnerPermissions,
              selection: chat.runnerModelSelection,
            },
            body.chatId
          );
          if (!claimed) return operationReceipt(row);
          try {
            let userCancelled = false;
            const response = await respondStream(body, userId, {
              chat,
              onUserCancelled: () => {
                userCancelled = true;
              },
            });
            if (!(response instanceof Response)) {
              // Preflight proves no execution was accepted. Consent retry may reuse the key.
              await releaseOperation(db, userId, operationId);
              return response;
            }
            let state: 'accepted' | 'running' = 'accepted';
            try {
              await finishOperation(db, userId, operationId, 'running');
              state = 'running';
            } catch (error) {
              console.error('[respond/stream] Could not persist running receipt', error);
            }
            // The hub drains its own runner stream; losing the HTTP acknowledgement
            // does not cancel accepted work or create a second execution.
            trackProductOperationWork(
              drainOperationStream(
                response,
                db,
                userId,
                operationId,
                chat.runner.kind === 'external',
                () => userCancelled
              )
            );
            return operationReceipt({ ...row, state });
          } catch (error) {
            await settleOperation(db, userId, operationId, 'unresolved');
            throw error;
          }
        } catch (error) {
          if (error instanceof OperationConflictError || error instanceof OperationExpiredError) {
            const expired = error instanceof OperationExpiredError;
            return apiErrorStatus(expired ? 410 : 409, {
              error: error.message,
              code: expired ? ERROR_CODES.OPERATION_EXPIRED : ERROR_CODES.CONFLICT,
            });
          }
          throw error;
        }
      })
  );
