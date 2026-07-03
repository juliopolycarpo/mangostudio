/**
 * ChatGPT binding for the shared OAuth token service — the only reader/writer
 * of the persisted bundle after the OAuth flow completes. Rotation safety
 * (single-flight refresh, persist-before-use) lives in ../oauth/token-service.
 */

import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../../lib/config';
import type { upsertSecretMetadata } from '../../../../services/secret-store/metadata';
import {
  createOAuthTokenService,
  markConnectorReauthRequired,
  type OAuthTokenService,
  type OAuthTokenServiceDeps,
} from '../oauth/token-service';
import {
  CHATGPT_REAUTH_REQUIRED_CODE,
  type ChatGptIdentity,
  chatGptOAuthProfile,
} from './oauth-client';

export interface ChatGptTokenServiceDeps extends OAuthTokenServiceDeps {
  authBaseUrl?: string;
}

export type ChatGptTokenService = OAuthTokenService<ChatGptIdentity>;

export function chatGptSecretName(connectorId: string): string {
  return `chatgpt-api-key:${connectorId}`;
}

export function markChatGptConnectorReauthRequired(
  connector: SecretMetadataRow,
  options: {
    now?: () => number;
    upsertMetadata?: typeof upsertSecretMetadata;
  } = {}
): Promise<void> {
  return markConnectorReauthRequired(connector, CHATGPT_REAUTH_REQUIRED_CODE, options);
}

export function createChatGptTokenService(deps: ChatGptTokenServiceDeps = {}): ChatGptTokenService {
  return createOAuthTokenService(
    {
      profile: chatGptOAuthProfile,
      secretName: chatGptSecretName,
      resolveAuthBaseUrl: () => deps.authBaseUrl ?? getConfig().chatgpt.authBaseUrl,
    },
    deps
  );
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
