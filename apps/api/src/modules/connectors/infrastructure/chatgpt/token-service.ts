/**
 * ChatGPT token bundle lifecycle — the only reader/writer of the persisted
 * bundle after the OAuth flow completes.
 *
 * Refresh tokens rotate on every refresh, so a concurrent double-refresh would
 * invalidate one of the rotated tokens. Refreshes are therefore single-flight
 * per connector id, and the rotated bundle is persisted before it is returned.
 */

import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../../lib/config';
import { upsertSecretMetadata } from '../../../../services/secret-store/metadata';
import { bunSecretStore, type SecretStore } from '../../../../services/secret-store/store';
import { parseStringArray } from '../../../../utils/json';
import {
  CHATGPT_REAUTH_REQUIRED_CODE,
  ChatGptOAuthError,
  ChatGptReauthRequiredError,
  type ChatGptTokenBundle,
  parseChatGptTokenBundle,
  refreshTokenGrant,
} from './oauth-client';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Refresh the access token when it expires within this window. */
const EXPIRY_SKEW_MS = 60_000;

export interface ChatGptTokenServiceDeps {
  secretStore?: SecretStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  authBaseUrl?: string;
  upsertMetadata?: typeof upsertSecretMetadata;
}

export interface ChatGptTokenService {
  /** Returns the stored bundle, refreshing (and persisting the rotation) when near expiry. */
  ensureFreshTokens(connector: SecretMetadataRow): Promise<ChatGptTokenBundle>;
  /**
   * Refreshes regardless of expiry (e.g. after the backend rejected an
   * unexpired access token with 401). Joins an in-flight refresh when present.
   */
  forceRefreshTokens(connector: SecretMetadataRow): Promise<ChatGptTokenBundle>;
  /** Reads and parses the stored bundle without refreshing. */
  readBundle(connectorId: string): Promise<ChatGptTokenBundle>;
  /** Persists a bundle for a connector id. */
  persistBundle(connectorId: string, bundle: ChatGptTokenBundle): Promise<void>;
  /** Deletes the persisted bundle for a connector id. */
  deleteBundle(connectorId: string): Promise<boolean>;
}

export function chatGptSecretName(connectorId: string): string {
  return `chatgpt-api-key:${connectorId}`;
}

export async function markChatGptConnectorReauthRequired(
  connector: SecretMetadataRow,
  options: {
    now?: () => number;
    upsertMetadata?: typeof upsertSecretMetadata;
  } = {}
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const upsertMetadata = options.upsertMetadata ?? upsertSecretMetadata;
  const timestamp = now();
  try {
    await upsertMetadata({
      ...connector,
      configured: true,
      updatedAt: timestamp,
      lastValidatedAt: timestamp,
      lastValidationError: CHATGPT_REAUTH_REQUIRED_CODE,
      enabledModels: parseStringArray(connector.enabledModels),
    });
  } catch {
    // Best-effort status metadata must not mask the re-auth error itself.
  }
}

export function createChatGptTokenService(deps: ChatGptTokenServiceDeps = {}): ChatGptTokenService {
  const secretStore = deps.secretStore ?? bunSecretStore;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const upsertMetadata = deps.upsertMetadata ?? upsertSecretMetadata;
  const resolveAuthBaseUrl = (): string => deps.authBaseUrl ?? getConfig().chatgpt.authBaseUrl;

  const inflightRefreshes = new Map<string, Promise<ChatGptTokenBundle>>();

  const readBundle = async (connectorId: string): Promise<ChatGptTokenBundle> => {
    const raw = await secretStore.getSecret({
      service: 'mangostudio',
      name: chatGptSecretName(connectorId),
    });
    if (!raw) {
      throw new ChatGptOAuthError('No stored ChatGPT tokens found for this connector.');
    }
    return parseChatGptTokenBundle(raw);
  };

  const persistBundle = async (connectorId: string, bundle: ChatGptTokenBundle): Promise<void> => {
    await secretStore.setSecret(
      { service: 'mangostudio', name: chatGptSecretName(connectorId) },
      JSON.stringify(bundle)
    );
  };

  const deleteBundle = (connectorId: string): Promise<boolean> => {
    return secretStore.deleteSecret({
      service: 'mangostudio',
      name: chatGptSecretName(connectorId),
    });
  };

  const refreshAndPersist = async (
    connector: SecretMetadataRow,
    bundle: ChatGptTokenBundle
  ): Promise<ChatGptTokenBundle> => {
    let rotated: ChatGptTokenBundle;
    try {
      rotated = await refreshTokenGrant({
        bundle,
        authBaseUrl: resolveAuthBaseUrl(),
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof ChatGptReauthRequiredError) {
        await markChatGptConnectorReauthRequired(connector, { now, upsertMetadata });
      }
      throw error;
    }
    await persistBundle(connector.id, rotated);
    await upsertMetadata({
      ...connector,
      configured: true,
      updatedAt: now(),
      lastValidatedAt: now(),
      lastValidationError: null,
      enabledModels: parseStringArray(connector.enabledModels),
    });
    return rotated;
  };

  const refreshSingleFlight = (
    connector: SecretMetadataRow,
    bundle: ChatGptTokenBundle
  ): Promise<ChatGptTokenBundle> => {
    const inflight = inflightRefreshes.get(connector.id);
    if (inflight) return inflight;

    const refresh = refreshAndPersist(connector, bundle).finally(() => {
      inflightRefreshes.delete(connector.id);
    });
    inflightRefreshes.set(connector.id, refresh);
    return refresh;
  };

  return {
    readBundle,
    persistBundle,
    deleteBundle,

    async ensureFreshTokens(connector: SecretMetadataRow): Promise<ChatGptTokenBundle> {
      const bundle = await readBundle(connector.id);
      if (bundle.expiresAt - now() > EXPIRY_SKEW_MS) return bundle;
      return refreshSingleFlight(connector, bundle);
    },

    async forceRefreshTokens(connector: SecretMetadataRow): Promise<ChatGptTokenBundle> {
      return refreshSingleFlight(connector, await readBundle(connector.id));
    },
  };
}

let instance = createChatGptTokenService();

/** Shared token service instance used by the provider stub and OAuth flow. */
export function getChatGptTokenService(): ChatGptTokenService {
  return instance;
}

/** Replaces the shared instance (tests only); pass null to restore the default. */
export function setChatGptTokenServiceForTests(service: ChatGptTokenService | null): void {
  instance = service ?? createChatGptTokenService();
}
