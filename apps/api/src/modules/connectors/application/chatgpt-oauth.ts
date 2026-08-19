/**
 * Use case: ChatGPT OAuth sign-in sessions.
 *
 * The API owns the whole flow: it creates the PKCE material, runs the loopback
 * redirect server, exchanges the authorization code, and persists the token
 * bundle as a regular `chatgpt` connector. The frontend only opens the
 * authorize URL and polls the session status.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChatGptOAuthStatus,
  StartChatGptOAuthBody,
  StartChatGptOAuthResponse,
} from '@mangostudio/shared/connectors';
import { getConfig } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { invalidateUnifiedCatalog } from '../../../services/providers/catalog';
import { invalidateProviderModelCache } from '../../../services/providers/core/provider-registry';
import { upsertSecretMetadata } from '../../../services/secret-store/metadata';
import { parseStringArray } from '../../../utils/json';
import { maskSecret } from '../../../utils/secrets';
import { startChatGptLoopbackServer } from '../infrastructure/chatgpt/loopback-server';
import {
  type ChatGptTokenBundle,
  chatGptOAuthProfile,
  exchangeAuthorizationCode,
} from '../infrastructure/chatgpt/oauth-client';
import { chatGptRedirectUri } from '../infrastructure/chatgpt/oauth-constants';
import { getChatGptTokenService } from '../infrastructure/chatgpt/token-service';
import { getSecretMetadataById } from '../infrastructure/connector-repository';
import { createOAuthState, createPkcePair } from '../infrastructure/oauth/pkce';
import {
  createOAuthSessionStore,
  type OAuthSessionBase,
} from '../infrastructure/oauth/session-store';
import { buildAuthorizeUrl } from '../infrastructure/oauth/token-client';
import { ConnectorValidationError } from './add-connector';
import { ConnectorNotFoundError } from './connector-errors';

const SESSION_TTL_MS = 300_000;
const oauthLogger = createDiagnosticLogger('chatgpt-oauth');

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ChatGptOAuthSession extends OAuthSessionBase {
  connectorName: string;
  targetConnectorId?: string;
  enabledModels: string[];
}

const sessions = createOAuthSessionStore<ChatGptOAuthSession>();

/** Injectable seams for the integration tests (fake auth server, fixed clock). */
export interface ChatGptOAuthDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

function markFailed(session: ChatGptOAuthSession, message: string, errorCode?: string): void {
  if (sessions.markFailed(session, message, errorCode)) {
    oauthLogger.warn('oauth_failed', { sessionId: session.id, error: message });
  }
}

async function completeSession(
  session: ChatGptOAuthSession,
  bundle: ChatGptTokenBundle,
  now: () => number
): Promise<void> {
  const connectorId = session.targetConnectorId ?? randomUUID();
  await getChatGptTokenService().persistBundle(connectorId, bundle);

  const timestamp = now();
  await upsertSecretMetadata({
    id: connectorId,
    name: session.connectorName,
    provider: 'chatgpt',
    configured: true,
    source: 'bun-secrets',
    maskedSuffix: maskSecret(bundle.email ?? bundle.accountId),
    updatedAt: timestamp,
    lastValidatedAt: timestamp,
    lastValidationError: null,
    enabledModels: session.enabledModels,
    userId: session.userId,
    baseUrl: null,
  });

  invalidateProviderModelCache('chatgpt', session.userId);
  invalidateUnifiedCatalog(session.userId);

  session.status = 'completed';
  session.connectorId = connectorId;
  oauthLogger.info('oauth_completed', {
    sessionId: session.id,
    connectorId,
    planType: bundle.planType,
  });
}

/** Starts a new OAuth session, replacing any pending session for the user. */
export async function startChatGptOAuth(
  userId: string,
  body: StartChatGptOAuthBody,
  deps: ChatGptOAuthDeps = {}
): Promise<StartChatGptOAuthResponse> {
  const connectorName = body.name.trim();
  if (!connectorName) {
    throw new ConnectorValidationError('Connector name cannot be empty.');
  }

  const now = deps.now ?? (() => Date.now());
  let targetConnectorId: string | undefined;
  let enabledModels: string[] = [];

  if (body.connectorId) {
    const connector = await getSecretMetadataById(body.connectorId, userId);
    if (connector?.provider !== 'chatgpt' || connector.userId !== userId) {
      throw new ConnectorNotFoundError();
    }
    targetConnectorId = connector.id;
    enabledModels = parseStringArray(connector.enabledModels);
  }

  // Single active session per user: a stale pending session would otherwise
  // hold the fixed loopback port until its TTL expires.
  sessions.cancelPendingForUser(userId);

  const { verifier, challenge } = await createPkcePair();
  const state = createOAuthState();
  const sessionId = randomUUID();
  const expiresAt = now() + SESSION_TTL_MS;

  const session: ChatGptOAuthSession = {
    id: sessionId,
    userId,
    connectorName,
    targetConnectorId,
    enabledModels,
    status: 'pending',
    expiresAt,
    loopback: startChatGptLoopbackServer({
      expectedState: state,
      ttlMs: SESSION_TTL_MS,
      onFailure: (message) => markFailed(session, message),
      onAuthorizationCode: async (code) => {
        try {
          const bundle = await exchangeAuthorizationCode({
            code,
            codeVerifier: verifier,
            authBaseUrl: getConfig().chatgpt.authBaseUrl,
            redirectUri: chatGptRedirectUri(session.loopback.port),
            fetchImpl: deps.fetchImpl,
          });
          await completeSession(session, bundle, now);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'ChatGPT sign-in failed unexpectedly.';
          const errorCode =
            error instanceof Error && 'code' in error ? String(error.code) : undefined;
          markFailed(session, message, errorCode);
          throw error;
        }
      },
    }),
  };
  sessions.add(session);
  oauthLogger.info('oauth_started', { sessionId, userId });

  return {
    sessionId,
    authorizeUrl: buildAuthorizeUrl(chatGptOAuthProfile, {
      authBaseUrl: getConfig().chatgpt.authBaseUrl,
      state,
      challenge,
      redirectUri: chatGptRedirectUri(session.loopback.port),
    }),
    expiresAt,
  };
}

function requireSession(userId: string, sessionId: string): ChatGptOAuthSession {
  const session = sessions.get(userId, sessionId);
  if (!session) throw new ConnectorNotFoundError();
  return session;
}

/** Returns the current status of an OAuth session owned by the user. */
export function getChatGptOAuthStatus(
  userId: string,
  sessionId: string,
  deps: ChatGptOAuthDeps = {}
): ChatGptOAuthStatus {
  const session = requireSession(userId, sessionId);
  const now = deps.now ?? (() => Date.now());

  sessions.expireIfDue(session, now());

  return {
    status: session.status,
    ...(session.connectorId ? { connectorId: session.connectorId } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.errorCode ? { errorCode: session.errorCode } : {}),
  };
}

/** Cancels a pending OAuth session and releases the loopback port. */
export function cancelChatGptOAuth(userId: string, sessionId: string): void {
  const session = requireSession(userId, sessionId);
  sessions.cancel(session);
  oauthLogger.info('oauth_cancelled', { sessionId, userId });
}

/** Clears all sessions and their loopback servers (for tests). */
export function resetChatGptOAuthSessions(): void {
  sessions.reset();
}
