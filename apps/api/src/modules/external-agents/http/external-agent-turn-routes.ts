/**
 * The two writes an external turn needs beyond the stream itself.
 *
 * `respond` answers a mid-turn approval. It authenticates and validates a shape,
 * and then delegates the entire decision to the approval registry — the five-way
 * binding, the option check, expiry and idempotency all live there. Re-deriving
 * any of it here would give a second, weaker path to the same vendor call.
 *
 * `fork-with-runner` is D14 made usable. A chat has one runner kind for life,
 * because a transcript that mixed owners would replay a vendor's assistant text
 * to MangoStudio's own model as its own prior output. So the selector offers a
 * new chat carrying environment and workdir instead of a switch, and this is the
 * endpoint behind that offer.
 *
 * Cancellation is deliberately absent: the existing stop endpoint reaches an
 * external turn through the active-turn registry, and a second one would be a
 * second way to end a turn with its own bugs.
 */

import { ChatRunnerConfigurationSchema, ChatSchema } from '@mangostudio/shared/chat';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { schemaMaxLengthFor } from '@mangostudio/shared/external-agents';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { toPublicChat } from '../../chats/application/public-chat';
import { createChat, getOwnedChat, updateChat } from '../../chats/infrastructure/chat-repository';
import {
  type ExternalTurnController,
  externalTurnController,
} from '../application/external-turn-controller';

/** Vendor ids, bounded exactly as they are everywhere else they cross the wire. */
const VendorIdSchema = t.String({ minLength: 1, maxLength: schemaMaxLengthFor('vendorId') });

const RespondBodySchema = t.Object({
  requestId: VendorIdSchema,
  optionId: VendorIdSchema,
});

const RespondResponseSchema = t.Object({
  status: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
  /** Echoed back so a client that raced another answer can reconcile. */
  optionId: t.Optional(VendorIdSchema),
  reason: t.Optional(t.String({ maxLength: 128 })),
});

const ForkBodySchema = t.Object({
  runner: ChatRunnerConfigurationSchema,
});

const ForkResponseSchema = t.Object({ chat: ChatSchema });

/**
 * A rejected answer is the request's fault or the turn's, never the server's.
 *
 * `not-found` covers both an approval that never existed and one this user may
 * not answer, deliberately: distinguishing them would confirm that another
 * user's approval exists.
 */
function statusForRejection(reason: string): number {
  switch (reason) {
    case 'not-found':
      return 404;
    case 'unknown-option':
      return 400;
    default:
      return 409;
  }
}

export function createExternalAgentTurnRoutes(
  controller: ExternalTurnController = externalTurnController
) {
  return new Elysia()
    .use(requireAuth)
    .post(
      '/chats/:chatId/external-agent/respond',
      async ({ params, body, user, set }) => {
        const result = await controller.answerApproval({
          userId: user?.id ?? '',
          chatId: params.chatId,
          requestId: body.requestId,
          optionId: body.optionId,
        });
        if (result.status === 'rejected') {
          set.status = statusForRejection(result.reason);
          return { status: 'rejected' as const, reason: result.reason };
        }
        return { status: 'accepted' as const, optionId: result.optionId };
      },
      {
        params: t.Object({ chatId: t.String({ minLength: 1, maxLength: 256 }) }),
        body: RespondBodySchema,
        response: {
          200: RespondResponseSchema,
          400: RespondResponseSchema,
          401: ApiErrorResponseSchema,
          404: RespondResponseSchema,
          409: RespondResponseSchema,
        },
      }
    )
    .post(
      '/chats/:chatId/fork-with-runner',
      async ({ params, body, user, set }) => {
        const userId = user?.id ?? '';
        const db = getDb();
        const source = await getOwnedChat(params.chatId, userId, db);
        if (!source) {
          set.status = 404;
          return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
        }

        const created = await createChat(
          { title: '', userId, environmentId: source.environmentId },
          db
        );
        // Environment and workdir carry; the transcript does not. That asymmetry
        // is the whole point — the user keeps their working context and the new
        // runner starts with a history it did not produce.
        await updateChat(
          created.id,
          userId,
          {
            runner: body.runner,
            workdir: source.workdir,
            // A forked chat has made no permission choice of its own. Copying the
            // source's would carry a choice made for a different runner, which
            // may not even support the pair.
            runnerPermissions: {},
          },
          db
        );
        const forked = await getOwnedChat(created.id, userId, db);

        set.status = 201;
        return {
          chat: toPublicChat({
            ...created,
            runner: forked?.runner ?? created.runner,
            runnerPermissions: forked?.runnerPermissions ?? {},
            workdir: source.workdir,
          }),
        };
      },
      {
        params: t.Object({ chatId: t.String({ minLength: 1, maxLength: 256 }) }),
        body: ForkBodySchema,
        response: {
          201: ForkResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
        },
      }
    );
}

export const externalAgentTurnRoutes = createExternalAgentTurnRoutes();
