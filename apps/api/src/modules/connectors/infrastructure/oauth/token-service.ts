/**
 * OAuth token bundle lifecycle, shared by all OAuth connectors — the only
 * reader/writer of the persisted bundle after the OAuth flow completes.
 *
 * Refresh tokens rotate on every refresh, so a concurrent double-refresh would
 * invalidate one of the rotated tokens. Refreshes are therefore single-flight
 * per connector id, and the rotated bundle is persisted before it is returned.
 */

import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { upsertSecretMetadata } from '../../../../services/secret-store/metadata';
import { bunSecretStore, type SecretStore } from '../../../../services/secret-store/store';
import { parseStringArray } from '../../../../utils/json';
import {
  type FetchLike,
  type OAuthProviderProfile,
  OAuthReauthRequiredError,
  type OAuthTokenBundle,
  parseTokenBundle,
  refreshTokenGrant,
} from './token-client';

/** Refresh the access token when it expires within this window. */
const EXPIRY_SKEW_MS = 60_000;

export interface OAuthTokenServiceConfig<TIdentity extends object> {
  profile: OAuthProviderProfile<TIdentity>;
  /** Secret-store entry name for a connector's bundle. */
  secretName(connectorId: string): string;
  /** Resolved per call so config overrides apply without rebuilding the service. */
  resolveAuthBaseUrl(): string;
}

/** Injectable seams for tests (fake secret store, fake auth server, fixed clock). */
export interface OAuthTokenServiceDeps {
  secretStore?: SecretStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  upsertMetadata?: typeof upsertSecretMetadata;
}

export interface OAuthTokenService<TIdentity extends object> {
  /** Returns the stored bundle, refreshing (and persisting the rotation) when near expiry. */
  ensureFreshTokens(connector: SecretMetadataRow): Promise<OAuthTokenBundle<TIdentity>>;
  /**
   * Refreshes regardless of expiry (e.g. after the backend rejected an
   * unexpired access token with 401). Joins an in-flight refresh when present.
   */
  forceRefreshTokens(connector: SecretMetadataRow): Promise<OAuthTokenBundle<TIdentity>>;
  /** Reads and parses the stored bundle without refreshing. */
  readBundle(connectorId: string): Promise<OAuthTokenBundle<TIdentity>>;
  /** Persists a bundle for a connector id. */
  persistBundle(connectorId: string, bundle: OAuthTokenBundle<TIdentity>): Promise<void>;
  /** Deletes the persisted bundle for a connector id. */
  deleteBundle(connectorId: string): Promise<boolean>;
}

/** Flags the connector row so the UI can surface a "sign in again" state. */
export async function markConnectorReauthRequired(
  connector: SecretMetadataRow,
  reauthErrorCode: string,
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
      lastValidationError: reauthErrorCode,
      enabledModels: parseStringArray(connector.enabledModels),
    });
  } catch {
    // Best-effort status metadata must not mask the re-auth error itself.
  }
}

export function createOAuthTokenService<TIdentity extends object>(
  config: OAuthTokenServiceConfig<TIdentity>,
  deps: OAuthTokenServiceDeps = {}
): OAuthTokenService<TIdentity> {
  const { profile } = config;
  const secretStore = deps.secretStore ?? bunSecretStore;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const upsertMetadata = deps.upsertMetadata ?? upsertSecretMetadata;

  const inflightRefreshes = new Map<string, Promise<OAuthTokenBundle<TIdentity>>>();

  const readBundle = async (connectorId: string): Promise<OAuthTokenBundle<TIdentity>> => {
    const raw = await secretStore.getSecret({
      service: 'mangostudio',
      name: config.secretName(connectorId),
    });
    if (!raw) {
      throw profile.createFlowError(`No stored ${profile.label} tokens found for this connector.`);
    }
    return parseTokenBundle(profile, raw);
  };

  const persistBundle = async (
    connectorId: string,
    bundle: OAuthTokenBundle<TIdentity>
  ): Promise<void> => {
    await secretStore.setSecret(
      { service: 'mangostudio', name: config.secretName(connectorId) },
      JSON.stringify(bundle)
    );
  };

  const deleteBundle = (connectorId: string): Promise<boolean> => {
    return secretStore.deleteSecret({
      service: 'mangostudio',
      name: config.secretName(connectorId),
    });
  };

  const refreshAndPersist = async (
    connector: SecretMetadataRow,
    bundle: OAuthTokenBundle<TIdentity>
  ): Promise<OAuthTokenBundle<TIdentity>> => {
    let rotated: OAuthTokenBundle<TIdentity>;
    try {
      rotated = await refreshTokenGrant(profile, {
        bundle,
        authBaseUrl: config.resolveAuthBaseUrl(),
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof OAuthReauthRequiredError) {
        await markConnectorReauthRequired(connector, error.code, { now, upsertMetadata });
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
    bundle: OAuthTokenBundle<TIdentity>
  ): Promise<OAuthTokenBundle<TIdentity>> => {
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

    async ensureFreshTokens(connector: SecretMetadataRow): Promise<OAuthTokenBundle<TIdentity>> {
      const bundle = await readBundle(connector.id);
      if (bundle.expiresAt - now() > EXPIRY_SKEW_MS) return bundle;
      return refreshSingleFlight(connector, bundle);
    },

    async forceRefreshTokens(connector: SecretMetadataRow): Promise<OAuthTokenBundle<TIdentity>> {
      return refreshSingleFlight(connector, await readBundle(connector.id));
    },
  };
}
