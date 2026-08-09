/**
 * One external turn, framed as the same SSE stream an internal turn produces.
 *
 * The transport is deliberately identical — same event framing, same keepalive,
 * same abort handling, same `done` terminator — because the client renders one
 * chat. Only the producer differs: an internal turn is an async generator the
 * route pulls from, while an external turn is a controller pushing events at
 * whatever rate a vendor process on another machine produces them. The queue
 * below is that adaptation and nothing more.
 *
 * Everything that decides *what* happens — ordering, dedup, persistence,
 * approval binding, cancellation, terminal reasons — belongs to the turn
 * controller. This module knows how to put bytes on a socket.
 */

import type { ExternalTurnRequest } from '@mangostudio/shared/generation';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import {
  externalAgentEventToStreamChunk,
  externalSessionStartedChunk,
} from '@mangostudio/shared/streaming';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import type { OwnedChatRecord } from '../../chats/infrastructure/chat-repository';
import { findActiveTurnByChat } from '../../generation/application/active-turn-registry';
import {
  type ExternalTurnConfigurationResolution,
  resolveExternalTurnConfiguration,
} from './external-turn-configuration';
import {
  ExternalTurnConflictError,
  type ExternalTurnController,
  externalTurnController,
} from './external-turn-controller';

const logger = createDiagnosticLogger('external-turn-stream');

/** Matches the internal streaming route; one interval for one chat experience. */
const KEEPALIVE_INTERVAL_MS = 15_000;

const KEEPALIVE_BYTES = new TextEncoder().encode(': keepalive\n\n');

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export interface StreamExternalTurnInput {
  readonly userId: string;
  readonly chat: OwnedChatRecord;
  readonly chatId: string;
  readonly prompt: string;
  readonly attachmentIds: readonly string[];
  /** The vendor model and effort the composer chose, if any. */
  readonly externalTurn: ExternalTurnRequest | undefined;
}

export interface ExternalTurnStreamDependencies {
  readonly controller?: ExternalTurnController;
  readonly resolveConfiguration?: typeof resolveExternalTurnConfiguration;
}

/**
 * Everything that can refuse a send before any SSE header is written.
 *
 * Pre-flight is the whole point: once the response is a stream the status code
 * is already 200, so a refusal after that is an error frame the user reads as a
 * failed turn rather than as a request that never started.
 */
export type ExternalTurnPreflightFailure =
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'validation'; readonly message: string };

export type ExternalTurnStreamResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly failure: ExternalTurnPreflightFailure };

export function createExternalTurnStream(dependencies: ExternalTurnStreamDependencies = {}) {
  const controller = dependencies.controller ?? externalTurnController;
  const resolveConfiguration =
    dependencies.resolveConfiguration ?? resolveExternalTurnConfiguration;

  return async function streamExternalTurn(
    input: StreamExternalTurnInput,
    db: Kysely<Database>
  ): Promise<ExternalTurnStreamResult> {
    if (input.chat.runner.kind !== 'external') {
      return {
        ok: false,
        failure: {
          kind: 'validation',
          message: 'This chat is not configured for an external agent.',
        },
      };
    }
    if (!input.chat.workdir) {
      return {
        ok: false,
        failure: {
          kind: 'validation',
          message: 'Choose a folder for this chat before starting an external agent turn.',
        },
      };
    }
    // Checked here as well as in the controller: a second send must be refused
    // with a status code, not with an error frame on a stream that already
    // committed a 200.
    if (findActiveTurnByChat(input.chatId)) {
      return {
        ok: false,
        failure: { kind: 'conflict', message: 'This chat already has a turn in progress.' },
      };
    }

    let resolution: ExternalTurnConfigurationResolution;
    try {
      resolution = await resolveConfiguration({
        userId: input.userId,
        chat: input.chat,
        targetId: input.chat.runner.targetId,
        workdir: input.chat.workdir,
        ...(input.externalTurn ? { request: input.externalTurn } : {}),
      });
    } catch (error) {
      logger.warn('configuration_unresolved', {
        chatId: input.chatId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return {
        ok: false,
        failure: {
          kind: 'unavailable',
          message: 'Could not reach the machine this chat runs on.',
        },
      };
    }
    if (!resolution.ok) {
      return { ok: false, failure: { kind: 'unsupported', message: resolution.message } };
    }

    return { ok: true, response: openStream(input, resolution, db, controller) };
  };
}

function openStream(
  input: StreamExternalTurnInput,
  resolution: Extract<ExternalTurnConfigurationResolution, { ok: true }>,
  db: Kysely<Database>,
  controller: ExternalTurnController
): Response {
  const stream = new ReadableStream({
    async start(streamController) {
      let closed = false;
      const enqueue = (bytes: Uint8Array) => {
        if (closed) return;
        try {
          streamController.enqueue(bytes);
        } catch {
          // The browser may already have cancelled the stream. The turn keeps
          // running and keeps persisting; only the live view is gone.
          closed = true;
        }
      };
      const send = (chunk: StreamChunk) => enqueue(sseEvent(chunk));

      const heartbeat = setInterval(() => enqueue(KEEPALIVE_BYTES), KEEPALIVE_INTERVAL_MS);

      try {
        const result = await controller.start(
          {
            userId: input.userId,
            chatId: input.chatId,
            prompt: input.prompt,
            ...(input.attachmentIds.length > 0 ? { attachmentIds: [...input.attachmentIds] } : {}),
            configuration: resolution.configuration,
            canonicalWorkspacePath: resolution.canonicalWorkspacePath,
            vendorAccountFingerprint: resolution.vendorAccountFingerprint,
            observer: {
              onSession(session) {
                send(externalSessionStartedChunk(session));
              },
              onTurnPrepared(ids) {
                send({ type: 'user_message_id', messageId: ids.userMessageId, done: false });
                send({
                  type: 'assistant_message_id',
                  messageId: ids.assistantMessageId,
                  done: false,
                });
              },
              onEvent(event) {
                const chunk = externalAgentEventToStreamChunk(event);
                if (chunk) send(chunk);
              },
            },
          },
          db
        );

        // The vendor's own failure already streamed as `external_error` and is
        // recorded on the turn. What the terminal state adds is why MangoStudio
        // stopped believing the turn would finish, which only some reasons have.
        const notice = terminalNoticeFor(result.reason);
        if (notice) send({ type: 'system_event', event: notice, done: false });

        send({ type: 'done', done: true, messageId: result.assistantMessageId });
      } catch (error) {
        // Everything reachable here failed before or during `start`, so no
        // `done` has been sent and the client is still waiting on this turn.
        logger.warn('turn_failed', {
          chatId: input.chatId,
          error: error instanceof Error ? error.message : 'unknown error',
        });
        send({
          type: 'error',
          error:
            error instanceof ExternalTurnConflictError
              ? error.message
              : 'The external agent turn could not be started.',
          done: true,
        });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          streamController.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
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

/**
 * The terminal reasons a user has to be told about in words.
 *
 * `completed` and `cancelled-by-user` need none — the transcript already shows
 * what happened, and narrating a stop the user pressed is noise. `vendor-error`
 * is omitted for the same reason: its structured error streamed already.
 */
function terminalNoticeFor(reason: string): string | null {
  switch (reason) {
    case 'runtime-disconnected':
      return 'external_runtime_disconnected';
    case 'hub-restarted':
      return 'external_hub_restarted';
    case 'sequence-gap':
      return 'external_sequence_gap';
    case 'limit-exceeded':
      return 'external_limit_exceeded';
    case 'consent-revoked':
      return 'external_consent_revoked';
    case 'session-lost':
      return 'external_session_lost';
    default:
      return null;
  }
}

export const streamExternalTurn = createExternalTurnStream();
