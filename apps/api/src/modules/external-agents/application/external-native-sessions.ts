/**
 * Continuing a conversation the user started in their terminal.
 *
 * Two operations, one set of guards. Listing shows which vendor sessions exist
 * on a machine; adoption points a new chat at one of them. Neither imports
 * anything: the vendor owns its transcript, and what MangoStudio records is a
 * pointer to it plus the marker that says so. Copying the history would create
 * two divergent copies of one conversation and would have to translate the
 * vendor's parts into MangoStudio's, lossily, for no one's benefit.
 *
 * ## Why the guards are the same for both
 *
 * A listing is not a lesser operation than a turn. Session titles and previews
 * are the first lines of somebody's conversations, so the same three questions
 * are answered before either call reaches a vendor:
 *
 * 1. **Is this environment the caller's?** Resolving the runtime client is what
 *    answers it — the connection manager only hands back environments the user
 *    owns — and it is also what proves the machine is reachable at all.
 * 2. **Can that machine keep vendor logins apart?** Without an isolation
 *    attestation the listing is not offered, which is stricter than the turn
 *    path needs to be and deliberately so: showing another OS user's
 *    conversation titles is a worse disclosure than sharing a credential.
 * 3. **Does the adapter actually have a listing?** `sessionListing` is derived
 *    from the adapter's own `listSessions` member, so a target that cannot
 *    enumerate — Claude Code, whose sessions live in an internal JSONL format
 *    the vendor explicitly declines to stabilize — says so rather than
 *    returning an empty page that reads as "you have no sessions".
 *
 * ## Why adoption re-reads
 *
 * The row the user clicked describes a moment that has already passed. The
 * session may have been deleted, archived, or continued in the terminal since
 * the picker rendered. So adoption asks the vendor again, and refuses when the
 * answer differs — a picker row is a hint, never a handle.
 */

import type { Chat } from '@mangostudio/shared/chat';
import type {
  ExternalAgentTargetId,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import { EXTERNAL_NATIVE_SESSION_PAGE_LIMIT } from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type { Database } from '../../../db/types';
import { getRuntimeClient, type RuntimeClient } from '../../../services/runtime-client';
import { generateId } from '../../../utils/id';
import { toPublicChat } from '../../chats/application/public-chat';
import { createChat, getOwnedChat, updateChat } from '../../chats/infrastructure/chat-repository';
import { insertMessage } from '../../messages/infrastructure/message-repository';
import {
  acquireAdoptionLease,
  EXTERNAL_ADOPTION_LEASE_TTL_MS,
} from '../infrastructure/external-session-adoption-lease-repository';
import { writeContinuation } from '../infrastructure/external-session-continuation-repository';
import {
  type ExternalAgentDiscoveryService,
  externalAgentDiscoveryService,
} from './external-agent-discovery';
import {
  type ExternalIdentityIsolationRegistry,
  externalIdentityIsolationRegistry,
} from './external-identity-isolation';

/** How long one listing call may take, including a cold vendor start. */
const LIST_TIMEOUT_MS = 30_000;

/**
 * How many pages adoption walks looking for the session it was asked about.
 *
 * Bounded because the re-read is on the path of a user click and a vendor with
 * a long history would otherwise page for as long as it liked. A session that
 * is not in the first few hundred entries of a recency-sorted listing is not
 * one anybody just picked out of a picker.
 */
const ADOPTION_LOOKUP_PAGES = 4;

/**
 * The marker part that says a chat continues somebody else's conversation.
 *
 * `system_event` rather than a new part type: the transcript already has a
 * vocabulary for "something happened here that nobody said", and adding a
 * fourteenth member to the part union for one line of text would spend a
 * contract change on a rendering detail.
 */
export const EXTERNAL_SESSION_ADOPTED_EVENT = 'external_session_adopted';

export type ExternalNativeSessionRefusalCode =
  /** The environment could not be reached, or is not this user's. */
  | 'unreachable'
  /** The target is not installed, signed out, or otherwise unavailable there. */
  | 'unavailable'
  /** The adapter has no session listing at all. */
  | 'unsupported'
  /** The machine has not proved it keeps vendor logins separate per user. */
  | 'isolation-unproven'
  /** The session named is gone, or is no longer what the picker showed. */
  | 'stale'
  /** Another chat is already attached to this vendor session. */
  | 'held'
  /** The vendor reported no working directory, so there is no chat to make. */
  | 'no-workspace';

interface Refusal {
  readonly ok: false;
  readonly code: ExternalNativeSessionRefusalCode;
  readonly message: string;
}

export type ExternalNativeSessionListing =
  | {
      readonly ok: true;
      readonly sessions: readonly ExternalNativeSession[];
      readonly nextCursor?: string;
    }
  | Refusal;

export type ExternalSessionAdoption = { readonly ok: true; readonly chat: Chat } | Refusal;

export interface ListExternalNativeSessionsInput {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly workspacePath?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdoptExternalNativeSessionInput {
  readonly userId: string;
  readonly environmentId: string;
  /** The row the picker rendered, echoed back so the re-read has something to check against. */
  readonly session: ExternalNativeSession;
}

export interface ExternalNativeSessionDependencies {
  readonly discovery?: ExternalAgentDiscoveryService;
  readonly resolveRuntimeClient?: typeof getRuntimeClient;
  readonly isolationRegistry?: ExternalIdentityIsolationRegistry;
  readonly db?: () => Kysely<Database>;
  readonly now?: () => number;
  readonly newMessageId?: () => string;
}

export interface ExternalNativeSessionService {
  list(input: ListExternalNativeSessionsInput): Promise<ExternalNativeSessionListing>;
  adopt(input: AdoptExternalNativeSessionInput): Promise<ExternalSessionAdoption>;
}

export function createExternalNativeSessionService(
  dependencies: ExternalNativeSessionDependencies = {}
): ExternalNativeSessionService {
  const discovery = dependencies.discovery ?? externalAgentDiscoveryService;
  const resolveRuntimeClient = dependencies.resolveRuntimeClient ?? getRuntimeClient;
  const isolationRegistry = dependencies.isolationRegistry ?? externalIdentityIsolationRegistry;
  const resolveDb = dependencies.db ?? getDb;
  const now = dependencies.now ?? Date.now;
  const newMessageId = dependencies.newMessageId ?? generateId;

  /**
   * Everything both operations need before a vendor is asked anything.
   *
   * Returns the client and the vendor account fingerprint, because adoption
   * writes that fingerprint into the continuation: a session opened under one
   * vendor account must not be resumed under another, and the value has to be
   * the one discovery just reported rather than one derived later.
   */
  async function authorize(
    userId: string,
    environmentId: string,
    targetId: ExternalAgentTargetId
  ): Promise<
    | {
        readonly ok: true;
        readonly client: RuntimeClient;
        readonly vendorAccountFingerprint: string | null;
        readonly credentialHomeFingerprint: string;
      }
    | Refusal
  > {
    let client: RuntimeClient;
    try {
      client = await resolveRuntimeClient(userId, environmentId);
    } catch {
      // One answer for "offline", "deleted" and "somebody else's", so the
      // response discloses nothing about environments this user cannot see.
      return {
        ok: false,
        code: 'unreachable',
        message: 'Could not reach the machine those sessions live on.',
      };
    }

    const isolation = isolationRegistry.resolve({
      userId,
      environmentId,
      ...(client.manifest?.identityIsolation
        ? { isolation: client.manifest.identityIsolation }
        : {}),
    });
    if (!isolation) {
      return {
        ok: false,
        code: 'isolation-unproven',
        message: 'This machine has not proved it can keep vendor logins separate per user.',
      };
    }

    const agents = await discovery.listExternalAgents({ userId, environmentId });
    const descriptor = agents.find((agent) => agent.targetId === targetId);
    if (!descriptor || descriptor.unavailableReason) {
      return {
        ok: false,
        code: 'unavailable',
        message: 'This agent cannot run on that machine right now.',
      };
    }
    if (!descriptor.capabilities.sessionListing) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'This agent does not publish a list of its own sessions.',
      };
    }

    return {
      ok: true,
      client,
      vendorAccountFingerprint: descriptor.account?.fingerprint ?? null,
      credentialHomeFingerprint: isolation.credentialHomeFingerprint,
    };
  }

  return {
    async list(input) {
      const authorized = await authorize(input.userId, input.environmentId, input.targetId);
      if (!authorized.ok) return authorized;

      const page = await authorized.client.externalAgents.listSessions(
        {
          targetId: input.targetId,
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: Math.min(
            input.limit ?? EXTERNAL_NATIVE_SESSION_PAGE_LIMIT,
            EXTERNAL_NATIVE_SESSION_PAGE_LIMIT
          ),
          timeoutMs: LIST_TIMEOUT_MS,
        },
        { timeoutMs: LIST_TIMEOUT_MS }
      );
      return {
        ok: true,
        sessions: page.sessions,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },

    async adopt(input) {
      const expected = input.session;
      const workspacePath = expected.workspacePath;
      if (!workspacePath) {
        return {
          ok: false,
          code: 'no-workspace',
          message: 'That session does not record a folder, so it cannot be continued here.',
        };
      }

      const authorized = await authorize(input.userId, input.environmentId, expected.targetId);
      if (!authorized.ok) return authorized;
      const client = authorized.client;

      // The re-read. Filtered to the workspace the row claimed, so a session
      // that moved is "gone" here rather than found under another directory.
      let cursor: string | undefined;
      let session: ExternalNativeSession | undefined;
      for (let page = 0; page < ADOPTION_LOOKUP_PAGES && !session; page += 1) {
        const listed = await client.externalAgents.listSessions(
          {
            targetId: expected.targetId,
            workspacePath,
            ...(cursor ? { cursor } : {}),
            limit: EXTERNAL_NATIVE_SESSION_PAGE_LIMIT,
            timeoutMs: LIST_TIMEOUT_MS,
          },
          { timeoutMs: LIST_TIMEOUT_MS }
        );
        session = listed.sessions.find(
          (candidate) => candidate.nativeSessionId === expected.nativeSessionId
        );
        cursor = listed.nextCursor;
        if (!cursor) break;
      }

      if (!session) {
        return {
          ok: false,
          code: 'stale',
          message: 'That session is no longer there. Refresh the list and pick again.',
        };
      }
      // A session that was written to since the picker rendered is one somebody
      // is using — possibly in the terminal this feature exists to continue
      // from. Adopting it silently would join a conversation mid-sentence.
      if (
        expected.updatedAtMs !== undefined &&
        session.updatedAtMs !== undefined &&
        session.updatedAtMs !== expected.updatedAtMs
      ) {
        return {
          ok: false,
          code: 'stale',
          message: 'That session changed since the list was loaded. Refresh and pick again.',
        };
      }
      if (session.workspacePath !== workspacePath) {
        return {
          ok: false,
          code: 'stale',
          message: 'That session now belongs to a different folder. Refresh and pick again.',
        };
      }

      const db = resolveDb();
      const timestamp = now();
      // The path as the machine that runs the vendor spells it — the same
      // canonicalization every turn performs, so the continuation written here
      // still matches when the first send re-derives the binding.
      const canonicalWorkspacePath = client.paths.canonical(workspacePath);

      const runAdoption = () =>
        db.transaction().execute(async (trx) => {
          const chat = await createChat(
            { title: '', userId: input.userId, environmentId: input.environmentId },
            trx
          );
          await updateChat(
            chat.id,
            input.userId,
            {
              runner: { kind: 'external', targetId: expected.targetId },
              workdir: canonicalWorkspacePath,
              // An adopted chat has made no permission choice of its own, exactly
              // like a forked one. The vendor's own session settings are the
              // vendor's; MangoStudio's pair starts at its default.
              runnerPermissions: {},
            },
            trx
          );

          // The lease is taken inside the transaction that creates the chat, so
          // a refused claim cannot leave a chat behind pointing at a session
          // this hub was just told it may not have.
          const lease = await acquireAdoptionLease(
            {
              environmentId: input.environmentId,
              targetId: expected.targetId,
              nativeSessionId: session.nativeSessionId,
              userId: input.userId,
              chatId: chat.id,
              acquiredAt: timestamp,
              expiresAt: timestamp + EXTERNAL_ADOPTION_LEASE_TTL_MS,
            },
            trx
          );
          if (!lease.acquired) throw new AdoptionLeaseHeldError();

          // The native session id goes here and nowhere else. The chat's runner
          // is user-set and client-visible; which vendor conversation it
          // resumes is neither, which is why the two live in separate tables.
          await writeContinuation(
            {
              chatId: chat.id,
              userId: input.userId,
              environmentId: input.environmentId,
              targetId: expected.targetId,
              canonicalWorkspacePath,
              vendorAccountFingerprint: authorized.vendorAccountFingerprint,
              credentialHomeFingerprint: authorized.credentialHomeFingerprint,
              // No runtime session exists yet: adoption records the pointer, and
              // the first send is what opens a vendor process for it.
              runtimeSessionId: '',
              nativeSessionId: session.nativeSessionId,
              effectiveConfiguration: null,
              updatedAt: timestamp,
              pendingAdoption: true,
            },
            trx
          );

          await insertMessage(
            {
              id: newMessageId(),
              chatId: chat.id,
              role: 'ai',
              text: '',
              timestamp,
              isGenerating: false,
              // The same mode every external turn is persisted under, so the
              // marker sits in one transcript with the turns that follow it.
              interactionMode: 'agent',
              parts: JSON.stringify([
                {
                  type: 'system_event',
                  event: EXTERNAL_SESSION_ADOPTED_EVENT,
                  detail: expected.targetId,
                },
              ]),
            },
            trx
          );

          const stored = await getOwnedChat(chat.id, input.userId, trx);
          if (!stored) throw new Error(`Adopted chat "${chat.id}" was not readable after write.`);
          return { chat, stored };
        });

      try {
        const { chat, stored } = await runAdoption();
        return {
          ok: true,
          chat: toPublicChat({
            ...chat,
            runner: stored.runner,
            runnerPermissions: stored.runnerPermissions,
            workdir: canonicalWorkspacePath,
          }),
        };
      } catch (error) {
        if (error instanceof AdoptionLeaseHeldError) {
          return { ok: false, code: 'held', message: error.message };
        }
        throw error;
      }
    },
  };
}

/** Thrown inside the adoption transaction so the chat it created is rolled back. */
class AdoptionLeaseHeldError extends Error {
  constructor() {
    super('That session is already open in another MangoStudio chat.');
    this.name = 'AdoptionLeaseHeldError';
  }
}

export const externalNativeSessionService = createExternalNativeSessionService();
