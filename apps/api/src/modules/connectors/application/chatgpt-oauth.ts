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
import {
  type ChatGptLoopbackServer,
  startChatGptLoopbackServer,
} from '../infrastructure/chatgpt/loopback-server';
import {
  type ChatGptTokenBundle,
  exchangeAuthorizationCode,
} from '../infrastructure/chatgpt/oauth-client';
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_SCOPES,
} from '../infrastructure/chatgpt/oauth-constants';
import { getChatGptTokenService } from '../infrastructure/chatgpt/token-service';
import { getSecretMetadataById } from '../infrastructure/connector-repository';
import { createOAuthState, createPkcePair } from '../infrastructure/oauth/pkce';
import { ConnectorValidationError } from './add-connector';
import { ConnectorNotFoundError } from './connector-errors';

const SESSION_TTL_MS = 300_000;
const oauthLogger = createDiagnosticLogger('chatgpt-oauth');

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OAuthSession {
  id: string;
  userId: string;
  connectorName: string;
  targetConnectorId?: string;
  enabledModels: string[];
  status: ChatGptOAuthStatus['status'];
  connectorId?: string;
  error?: string;
  errorCode?: string;
  expiresAt: number;
  loopback: ChatGptLoopbackServer;
}

const sessions = new Map<string, OAuthSession>();

/** Injectable seams for the integration tests (fake auth server, fixed clock). */
export interface ChatGptOAuthDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

function markFailed(session: OAuthSession, message: string, errorCode?: string): void {
  if (session.status !== 'pending') return;
  session.status = 'failed';
  session.error = message;
  if (errorCode) session.errorCode = errorCode;
  oauthLogger.warn('oauth_failed', { sessionId: session.id, error: message });
}

async function completeSession(
  session: OAuthSession,
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

function buildAuthorizeUrl(authBaseUrl: string, state: string, challenge: string): string {
  const url = new URL('/oauth/authorize', authBaseUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
    scope: CHATGPT_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return url.toString();
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
    if (!connector || connector.provider !== 'chatgpt' || connector.userId !== userId) {
      throw new ConnectorNotFoundError();
    }
    targetConnectorId = connector.id;
    enabledModels = parseStringArray(connector.enabledModels);
  }

  // Single active session per user: a stale pending session would otherwise
  // hold the fixed loopback port until its TTL expires.
  for (const session of sessions.values()) {
    if (session.userId === userId && session.status === 'pending') {
      session.loopback.stop();
      sessions.delete(session.id);
    }
  }

  const { verifier, challenge } = await createPkcePair();
  const state = createOAuthState();
  const sessionId = randomUUID();
  const expiresAt = now() + SESSION_TTL_MS;

  const session: OAuthSession = {
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
  sessions.set(sessionId, session);
  oauthLogger.info('oauth_started', { sessionId, userId });

  return {
    sessionId,
    authorizeUrl: buildAuthorizeUrl(getConfig().chatgpt.authBaseUrl, state, challenge),
    expiresAt,
  };
}

function requireSession(userId: string, sessionId: string): OAuthSession {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) throw new ConnectorNotFoundError();
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

  if (session.status === 'pending' && now() > session.expiresAt) {
    session.status = 'expired';
    session.loopback.stop();
  }

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
  session.loopback.stop();
  sessions.delete(sessionId);
  oauthLogger.info('oauth_cancelled', { sessionId, userId });
}

/** Clears all sessions and their loopback servers (for tests). */
export function resetChatGptOAuthSessions(): void {
  for (const session of sessions.values()) {
    session.loopback.stop();
  }
  sessions.clear();
}
