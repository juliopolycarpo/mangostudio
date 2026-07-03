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
  ChatGptOAuthError,
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
  /** Reads and parses the stored bundle without refreshing. */
  readBundle(connectorId: string): Promise<ChatGptTokenBundle>;
  /** Persists a bundle for a connector id. */
  persistBundle(connectorId: string, bundle: ChatGptTokenBundle): Promise<void>;
}

export function chatGptSecretName(connectorId: string): string {
  return `chatgpt-api-key:${connectorId}`;
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

  const refreshAndPersist = async (
    connector: SecretMetadataRow,
    bundle: ChatGptTokenBundle
  ): Promise<ChatGptTokenBundle> => {
    const rotated = await refreshTokenGrant({
      bundle,
      authBaseUrl: resolveAuthBaseUrl(),
      fetchImpl,
    });
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

  return {
    readBundle,
    persistBundle,

    async ensureFreshTokens(connector: SecretMetadataRow): Promise<ChatGptTokenBundle> {
      const bundle = await readBundle(connector.id);
      if (bundle.expiresAt - now() > EXPIRY_SKEW_MS) return bundle;

      const inflight = inflightRefreshes.get(connector.id);
      if (inflight) return inflight;

      const refresh = refreshAndPersist(connector, bundle).finally(() => {
        inflightRefreshes.delete(connector.id);
      });
      inflightRefreshes.set(connector.id, refresh);
      return refresh;
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
