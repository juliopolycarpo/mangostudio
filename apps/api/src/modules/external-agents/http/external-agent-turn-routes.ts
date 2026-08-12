/**
 * The four writes an external turn needs beyond the stream itself.
 *
 * `respond` answers a mid-turn approval. It authenticates and validates a shape,
 * and then delegates the entire decision to the approval registry — the five-way
 * binding, the option check, expiry and idempotency all live there. Re-deriving
 * any of it here would give a second, weaker path to the same vendor call.
 *
 * `steer` sends more input into the turn that is currently running, Codex only.
 * Like `respond`, it authenticates and validates a shape and delegates the
 * decision — here, to the turn controller, which is the only thing that knows
 * which turn is live for this chat and can address it.
 *
 * `fork-with-runner` is D14 made usable. A chat has one runner kind for life,
 * because a transcript that mixed owners would replay a vendor's assistant text
 * to MangoStudio's own model as its own prior output. So the selector offers a
 * new chat carrying environment and workdir instead of a switch, and this is the
 * endpoint behind that offer.
 *
 * `trust-workspace` records that the user agreed to let this vendor load the
 * chat's workspace configuration. Every value it stores is re-derived from the
 * chat — the canonical path exactly as the turn derives it — so a client cannot
 * widen the grant by spelling a directory differently. The scope in the body is
 * not an input to that derivation; it is the scope the refusal disclosed, and
 * the request is refused when the two no longer agree. Consent names a
 * workspace, and the workspace can change while the dialog is open.
 *
 * Cancellation is deliberately absent: the existing stop endpoint reaches an
 * external turn through the active-turn registry, and a second one would be a
 * second way to end a turn with its own bugs.
 */

import { ChatRunnerConfigurationSchema, ChatSchema } from '@mangostudio/shared/chat';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import {
  ExternalAgentSteerResultSchema,
  schemaMaxLengthFor,
} from '@mangostudio/shared/external-agents';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getRuntimeClient } from '../../../services/runtime-client';
import { toPublicChat } from '../../chats/application/public-chat';
import { createChat, getOwnedChat, updateChat } from '../../chats/infrastructure/chat-repository';
import {
  type ExternalTurnController,
  externalTurnController,
} from '../application/external-turn-controller';
import { grantWorkspaceTrust } from '../application/external-workspace-trust';

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

const SteerBodySchema = t.Object({
  clientMessageId: VendorIdSchema,
  text: t.String({ minLength: 1, maxLength: 1024 * 1024 }),
});

const ForkBodySchema = t.Object({
  runner: ChatRunnerConfigurationSchema,
});

const ForkResponseSchema = t.Object({ chat: ChatSchema });

const WorkspacePathSchema = t.String({ minLength: 1, maxLength: 4_096 });

/**
 * The scope the refusal disclosed, as the dialog rendered it.
 *
 * Not an input to the grant — every value stored is still derived from the chat
 * — but the expectation the grant is checked against. Without it the endpoint
 * grants whatever the chat says *now*, and a chat edited from another tab while
 * the dialog was open would have the user's consent applied to a workspace,
 * machine or vendor they never saw.
 */
const TrustWorkspaceBodySchema = t.Object({
  workspacePath: WorkspacePathSchema,
  targetId: VendorIdSchema,
  environmentId: t.String({ minLength: 1, maxLength: 256 }),
});

const TrustWorkspaceResponseSchema = t.Object({
  /** The canonical directory the grant covers, as the target machine spells it. */
  workspacePath: WorkspacePathSchema,
});

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

export interface ExternalAgentTurnRouteDependencies {
  /**
   * How the canonical workspace is spelled. Injectable because it is the one
   * thing in these routes that reaches another machine, and a test that could
   * not replace it would either need a live runtime or would skip the only
   * step that makes a trust grant match the check that reads it.
   */
  readonly resolveRuntimeClient?: typeof getRuntimeClient;
}

export function createExternalAgentTurnRoutes(
  controller: ExternalTurnController = externalTurnController,
  dependencies: ExternalAgentTurnRouteDependencies = {}
) {
  const resolveRuntimeClient = dependencies.resolveRuntimeClient ?? getRuntimeClient;
  return new Elysia()
    .use(requireAuth)
    .post(
      '/chats/:id/external-agent/respond',
      async ({ params, body, user, set }) => {
        const result = await controller.answerApproval({
          userId: user?.id ?? '',
          chatId: params.id,
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
        params: t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) }),
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
      '/chats/:id/external-agent/steer',
      async ({ params, body, user, set }) => {
        const result = await controller.steer({
          userId: user?.id ?? '',
          chatId: params.id,
          clientMessageId: body.clientMessageId,
          text: body.text,
        });
        // Every rejection reads as a conflict: the chat and the request are
        // both well-formed, but the turn this was addressed to is not there to
        // steer, right now, for whichever of the reasonCode's causes applies.
        if (!result.accepted) set.status = 409;
        return result;
      },
      {
        params: t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) }),
        body: SteerBodySchema,
        response: {
          200: ExternalAgentSteerResultSchema,
          401: ApiErrorResponseSchema,
          409: ExternalAgentSteerResultSchema,
        },
      }
    )
    .post(
      '/chats/:id/fork-with-runner',
      async ({ params, body, user, set }) => {
        const userId = user?.id ?? '';
        const db = getDb();
        const source = await getOwnedChat(params.id, userId, db);
        if (!source) {
          set.status = 404;
          return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
        }

        // One transaction, because a fork is one thing. `createChat` commits a
        // blank MangoStudio chat and `updateChat` is what makes it the fork the
        // user asked for; a failure between them would answer with an error and
        // still leave that blank chat in the sidebar.
        const { created, forked } = await db.transaction().execute(async (trx) => {
          const created = await createChat(
            { title: '', userId, environmentId: source.environmentId },
            trx
          );
          // Environment and workdir carry; the transcript does not. That
          // asymmetry is the whole point — the user keeps their working context
          // and the new runner starts with a history it did not produce.
          await updateChat(
            created.id,
            userId,
            {
              runner: body.runner,
              workdir: source.workdir,
              // A forked chat has made no permission choice of its own. Copying
              // the source's would carry a choice made for a different runner,
              // which may not even support the pair.
              runnerPermissions: {},
            },
            trx
          );
          const forked = await getOwnedChat(created.id, userId, trx);
          if (!forked) throw new Error(`Forked chat "${created.id}" was not readable after write.`);
          return { created, forked };
        });

        set.status = 201;
        return {
          chat: toPublicChat({
            ...created,
            runner: forked.runner,
            runnerPermissions: forked.runnerPermissions,
            workdir: source.workdir,
          }),
        };
      },
      {
        params: t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) }),
        body: ForkBodySchema,
        response: {
          201: ForkResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/chats/:id/external-agent/trust-workspace',
      async ({ params, body, user, set }) => {
        const userId = user?.id ?? '';
        const db = getDb();
        const chat = await getOwnedChat(params.id, userId, db);
        if (!chat) {
          set.status = 404;
          return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
        }
        if (chat.runner.kind !== 'external') {
          set.status = 400;
          return {
            error: 'This chat is not configured for an external agent.',
            code: ERROR_CODES.VALIDATION,
          };
        }
        if (!chat.workdir) {
          set.status = 400;
          return {
            error: 'Choose a folder for this chat before trusting it.',
            code: ERROR_CODES.VALIDATION,
          };
        }

        let workspacePath: string;
        try {
          // The same canonicalization the turn performs, on the same machine's
          // path semantics. Anything else would trust a directory the check
          // will not recognize.
          const client = await resolveRuntimeClient(userId, chat.environmentId);
          workspacePath = client.paths.canonical(chat.workdir);
        } catch {
          set.status = 503;
          return {
            error: 'Could not reach the machine this chat runs on.',
            code: ERROR_CODES.PROVIDER_ERROR,
          };
        }

        // The scope the refusal disclosed, echoed back by the dialog that
        // displayed it. Never used to derive anything — the three values above
        // still come from the chat — only to check that the answer belongs to
        // the question. A chat's workdir, environment or runner can change from
        // another tab while this dialog is open, and the grant would otherwise
        // cover a workspace the user was never shown.
        if (
          body.workspacePath !== workspacePath ||
          body.targetId !== chat.runner.targetId ||
          body.environmentId !== chat.environmentId
        ) {
          set.status = 409;
          return {
            error: 'This chat changed while you were deciding. Try the message again.',
            code: ERROR_CODES.CONFLICT,
          };
        }

        await grantWorkspaceTrust(
          {
            userId,
            targetId: chat.runner.targetId,
            environmentId: chat.environmentId,
            workspacePath,
          },
          db
        );
        return { workspacePath };
      },
      {
        params: t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) }),
        body: TrustWorkspaceBodySchema,
        response: {
          200: TrustWorkspaceResponseSchema,
          400: ApiErrorResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    );
}

export const externalAgentTurnRoutes = createExternalAgentTurnRoutes();
