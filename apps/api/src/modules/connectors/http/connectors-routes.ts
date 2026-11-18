/**
 * Connector CRUD HTTP routes — thin adapter over the application layer.
 * Parse → call use case → respond. No business logic here.
 */

import type { ConnectorStatus } from '@mangostudio/shared/connectors';
import {
  AddConnectorBodySchema,
  UpdateConnectorModelsBodySchema,
} from '@mangostudio/shared/connectors';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, status, t } from 'elysia';

import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  GeminiValidationUnavailableError,
  InvalidGeminiApiKeyError,
} from '../../../services/gemini';
import { SecretStorageUnavailableError } from '../../../services/secret-store';
import { addConnector, ConnectorValidationError } from '../application/add-connector';
import { ChatGptUsageActionError } from '../application/chatgpt-usage';
import { ConnectorNotFoundError, ConnectorOwnershipError } from '../application/connector-errors';
import { listConnectors } from '../application/list-connectors';
import { removeConnector } from '../application/remove-connector';
import { updateConnectorModels } from '../application/update-connector-models';
import { ChatGptOAuthPortBusyError } from '../infrastructure/chatgpt/loopback-server';
import {
  ChatGptOAuthError,
  ChatGptReauthRequiredError,
} from '../infrastructure/chatgpt/oauth-client';
import {
  OpenAIAuthError,
  OpenAIConfigError,
  UnsafeBaseUrlError,
} from '../infrastructure/provider-validation';

/**
 * Maps a connector failure to its typed `status(code, body)` answer, so the body
 * lands in Eden's `error` channel on every connector route.
 */
export function handleConnectorError(error: unknown) {
  if (error instanceof ConnectorValidationError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  if (error instanceof ConnectorNotFoundError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  if (error instanceof ConnectorOwnershipError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  if (
    error instanceof ChatGptOAuthPortBusyError ||
    error instanceof ChatGptOAuthError ||
    error instanceof ChatGptReauthRequiredError ||
    error instanceof ChatGptUsageActionError
  ) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  if (error instanceof UnsafeBaseUrlError) {
    return status(422, { error: error.message, code: ERROR_CODES.VALIDATION });
  }

  if (error instanceof InvalidGeminiApiKeyError) {
    return status(422, { error: error.message, code: ERROR_CODES.VALIDATION });
  }

  if (error instanceof SecretStorageUnavailableError) {
    return status(503, {
      error: 'OS secret storage is unavailable on this machine.',
      code: ERROR_CODES.PROVIDER_ERROR,
    });
  }

  if (error instanceof GeminiValidationUnavailableError) {
    return status(502, { error: error.message, code: ERROR_CODES.PROVIDER_ERROR });
  }

  if (error instanceof OpenAIAuthError) {
    return apiErrorStatus(error.status, { error: error.message, code: ERROR_CODES.VALIDATION });
  }

  if (error instanceof OpenAIConfigError) {
    return status(422, { error: error.message, code: ERROR_CODES.VALIDATION });
  }

  console.error('[connectors] Unexpected error:', error);
  return status(500, {
    error: error instanceof Error ? error.message : 'Unexpected connector error.',
    code: ERROR_CODES.INTERNAL,
  });
}

export const connectorRoutes = new Elysia()
  .use(requireAuth)

  // Migrated from ESLint
  .get('/connectors', async ({ user }): Promise<ConnectorStatus> => {
    return listConnectors(user?.id ?? '');
  })

  .post('/connectors', { body: AddConnectorBodySchema }, async ({ body, user }) => {
    try {
      return await addConnector(user?.id ?? '', body);
    } catch (error) {
      return handleConnectorError(error);
    }
  })

  .delete('/connectors/:id', { params: t.Object({ id: t.String() }) }, async ({ params, user }) => {
    try {
      await removeConnector(user?.id ?? '', params.id);
      return { success: true as const };
    } catch (error) {
      return handleConnectorError(error);
    }
  })

  .put(
    '/connectors/:id/models',
    {
      params: t.Object({ id: t.String() }),
      body: UpdateConnectorModelsBodySchema,
    },
    async ({ params, body, user }) => {
      try {
        await updateConnectorModels(user?.id ?? '', params.id, body.enabledModels);
        return { success: true as const };
      } catch (error) {
        return handleConnectorError(error);
      }
    }
  );
