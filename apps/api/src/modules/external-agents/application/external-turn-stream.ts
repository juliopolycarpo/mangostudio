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

import type {
  ExternalAgentTargetId,
  ExternalReviewTarget,
} from '@mangostudio/shared/external-agents';
import type { ExternalTurnRequest } from '@mangostudio/shared/generation';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import {
  externalAgentEventToStreamChunk,
  externalSessionStartedChunk,
  externalSteerChunk,
  externalTurnCompletedChunk,
} from '@mangostudio/shared/streaming';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import type { OwnedChatRecord } from '../../chats/infrastructure/chat-repository';
import { findActiveTurnByChat } from '../../generation/application/active-turn-registry';
import { getRepoRoot } from '../../git/application/git-status-service';
import { requiresExternalDisclosure } from './external-disclosure-gate';
import {
  type ExternalTurnConfigurationResolution,
  resolveExternalTurnConfiguration,
} from './external-turn-configuration';
import {
  ExternalTurnConflictError,
  type ExternalTurnController,
  externalTurnController,
} from './external-turn-controller';
import { requiresWorkspaceTrust } from './external-workspace-trust';

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
  /** Runs a vendor-native review of the working tree instead of relaying the prompt. */
  readonly review?: { readonly target: ExternalReviewTarget };
}

export interface ExternalTurnStreamDependencies {
  readonly controller?: ExternalTurnController;
  readonly resolveConfiguration?: typeof resolveExternalTurnConfiguration;
  /**
   * Reads the workspace's Git root **through the machine that owns it**.
   *
   * Injectable for the same reason the runtime client is elsewhere: this is the
   * one preflight step that reaches another filesystem, and a test that could
   * not replace it would either need a live runtime or would skip the check
   * that makes a review of "uncommitted changes" mean anything.
   */
  readonly resolveRepoRoot?: typeof getRepoRoot;
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
  /**
   * The environment has not proved that vendor credentials belong to the user
   * whose turn this is. Refused here as well as in discovery because discovery
   * is cached and this is not.
   */
  | { readonly kind: 'isolation-unproven'; readonly message: string }
  /**
   * The user has not acknowledged this vendor's third-party disclosure, or has
   * acknowledged a materially different one. Carries the vendor so the client
   * knows which disclosure to render, and the environment because the
   * acknowledgement is recorded against the descriptor the user was shown.
   */
  | {
      readonly kind: 'disclosure-required';
      readonly message: string;
      readonly targetId: ExternalAgentTargetId;
      readonly environmentId: string;
    }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'validation'; readonly message: string }
  /**
   * A review was asked for on a workspace that is not a Git repository.
   *
   * MangoStudio's own precondition. Codex completes such a review instead of
   * refusing it — it logs `fatal: not a git repository` internally and reviews
   * nothing — so an action called "review my changes" would silently review
   * none of them without this.
   */
  | { readonly kind: 'review-requires-git'; readonly message: string }
  /**
   * The vendor would load this workspace's own configuration and the user has
   * not agreed to that yet. Carries the whole scope the grant would cover, not
   * just the path the dialog prints: the client echoes it back when recording
   * consent, and the grant is refused if the chat no longer resolves to it.
   */
  | {
      readonly kind: 'workspace-trust';
      readonly message: string;
      readonly workspacePath: string;
      readonly targetId: ExternalAgentTargetId;
      readonly environmentId: string;
    };

export type ExternalTurnStreamResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly failure: ExternalTurnPreflightFailure };

export function createExternalTurnStream(dependencies: ExternalTurnStreamDependencies = {}) {
  const controller = dependencies.controller ?? externalTurnController;
  const resolveConfiguration =
    dependencies.resolveConfiguration ?? resolveExternalTurnConfiguration;
  const resolveRepoRoot = dependencies.resolveRepoRoot ?? getRepoRoot;

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
      // Two different refusals with two different remedies. "Change a setting"
      // is on the user; "this machine cannot keep vendor logins separate" is on
      // whoever administers it, and flattening them into one message would send
      // people to the wrong place.
      return {
        ok: false,
        failure: {
          kind: resolution.isolationUnproven ? 'isolation-unproven' : 'unsupported',
          message: resolution.message,
        },
      };
    }

    // The descriptor this machine actually answered with, before anything is
    // spent on the review: the session's own capabilities are checked again at
    // start, which is what catches a descriptor that has gone stale.
    if (input.review && !resolution.descriptor.capabilities.nativeReview) {
      return {
        ok: false,
        failure: {
          kind: 'unsupported',
          message: 'This agent does not offer a review of your working tree.',
        },
      };
    }

    // Authoritative, and deliberately not the descriptor's cached
    // `disclosure-required`: the selector's copy of that answer can be minutes
    // old, and an acknowledgement revoked in another tab has to take effect on
    // the next send rather than on the next cache expiry. The external API
    // reaches this same check, which is what makes the gate a safeguard instead
    // of a courtesy the browser extends to itself.
    if (
      await requiresExternalDisclosure(
        { userId: input.userId, targetId: input.chat.runner.targetId },
        {
          capabilities: resolution.descriptor.capabilities,
          supportedConfigurations: resolution.descriptor.supportedConfigurations,
        },
        db
      )
    ) {
      return {
        ok: false,
        failure: {
          kind: 'disclosure-required',
          message: 'This agent needs its third-party disclosure acknowledged before it can run.',
          targetId: input.chat.runner.targetId,
          environmentId: input.chat.environmentId,
        },
      };
    }

    // After resolution, because the canonical path is what gets trusted and only
    // the runtime that owns the machine can spell it. Before the stream, because
    // a refusal after the 200 is committed reads as a turn that failed rather
    // than as one that never began.
    if (
      await requiresWorkspaceTrust(
        {
          userId: input.userId,
          targetId: input.chat.runner.targetId,
          environmentId: input.chat.environmentId,
          workspacePath: resolution.canonicalWorkspacePath,
        },
        db
      )
    ) {
      return {
        ok: false,
        failure: {
          kind: 'workspace-trust',
          message: 'This workspace has not been trusted for this agent yet.',
          workspacePath: resolution.canonicalWorkspacePath,
          targetId: input.chat.runner.targetId,
          environmentId: input.chat.environmentId,
        },
      };
    }

    // Last of the preflight, because it is the only step that spends a round
    // trip on another machine, and because it needs the canonical workspace
    // that machine spelled. Asked *through the runtime* rather than of the
    // hub's own filesystem: the workspace may be on an SSH host, in a
    // container, in WSL or on a paired machine, and a hub-side check would be
    // answering a question about the wrong disk.
    if (input.review) {
      let repoRoot: string | null;
      try {
        repoRoot = await resolveRepoRoot(resolution.canonicalWorkspacePath, undefined, {
          userId: input.userId,
          environmentId: input.chat.environmentId,
        });
      } catch (error) {
        logger.warn('review_repo_check_failed', {
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
      if (!repoRoot) {
        return {
          ok: false,
          failure: {
            kind: 'review-requires-git',
            message: 'This folder is not a Git repository, so there are no changes to review.',
          },
        };
      }
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
            ...(input.review ? { review: input.review } : {}),
            canonicalWorkspacePath: resolution.canonicalWorkspacePath,
            vendorAccountFingerprint: resolution.vendorAccountFingerprint,
            credentialHomeFingerprint: resolution.credentialHomeFingerprint,
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
              onSteer(steer) {
                if (steer.status === 'rejected') {
                  if (steer.reasonCode !== undefined) {
                    send(externalSteerChunk({ ...steer, reasonCode: steer.reasonCode }));
                  }
                  return;
                }
                send(
                  externalSteerChunk({
                    clientMessageId: steer.clientMessageId,
                    text: steer.text,
                    status: 'accepted',
                  })
                );
              },
            },
          },
          db
        );

        // Before `done`, and always: the same value the durable record keeps, so
        // a reload does not change what the user was told about this turn.
        send(externalTurnCompletedChunk(result.reason));
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

export const streamExternalTurn = createExternalTurnStream();
