/**
 * Connector API mutation functions.
 */

import type { Connector } from '@mangostudio/shared';
import type {
  ChatGptOAuthStatus,
  StartChatGptOAuthBody,
  StartChatGptOAuthResponse,
} from '@mangostudio/shared/connectors';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { en } from '@mangostudio/shared/i18n';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

const fallback = en.settings.connectors;

export class ConnectorApiError extends Error {
  readonly code?: string;

  constructor(value: unknown, fallbackMessage: string) {
    super(extractApiError(value, fallbackMessage));
    this.name = 'ConnectorApiError';
    if (value && typeof value === 'object') {
      const maybeError = value as Partial<ApiErrorResponse>;
      if (typeof maybeError.code === 'string') this.code = maybeError.code;
    }
  }
}

export async function addConnector(
  body: Parameters<typeof client.api.settings.connectors.post>[0]
): Promise<Connector> {
  const { data, error } = await client.api.settings.connectors.post(body);
  if (error) throw new ConnectorApiError(error.value, fallback.failedToAdd);
  return data as Connector;
}

export async function deleteConnector(id: string): Promise<void> {
  const { error } = await client.api.settings.connectors({ id }).delete();
  if (error) throw new ConnectorApiError(error.value, fallback.failedToDelete);
}

export async function updateConnectorModels(id: string, enabledModels: string[]): Promise<void> {
  const { error } = await client.api.settings.connectors({ id }).models.put({ enabledModels });
  if (error) throw new ConnectorApiError(error.value, fallback.failedToUpdateModels);
}

export async function startChatGptOAuth(
  body: StartChatGptOAuthBody
): Promise<StartChatGptOAuthResponse> {
  const { data, error } = await client.api.settings.connectors.chatgpt.oauth.start.post(body);
  if (error) throw new ConnectorApiError(error.value, fallback.chatgptFailedError);
  return data as StartChatGptOAuthResponse;
}

export async function getChatGptOAuthStatus(sessionId: string): Promise<ChatGptOAuthStatus> {
  const { data, error } = await client.api.settings.connectors.chatgpt
    .oauth({
      sessionId,
    })
    .status.get();
  if (error) throw new ConnectorApiError(error.value, fallback.chatgptFailedError);
  return data as ChatGptOAuthStatus;
}

export async function cancelChatGptOAuth(sessionId: string): Promise<void> {
  const { error } = await client.api.settings.connectors.chatgpt
    .oauth({
      sessionId,
    })
    .cancel.post();
  if (error) throw new ConnectorApiError(error.value, fallback.chatgptFailedError);
}
