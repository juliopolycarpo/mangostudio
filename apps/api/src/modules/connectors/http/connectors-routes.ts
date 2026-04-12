/**
 * Connector CRUD HTTP routes — thin adapter over the application layer.
 * Parse → call use case → respond. No business logic here.
 */

import { Elysia, t } from 'elysia';
import {
  AddConnectorBodySchema,
  UpdateConnectorModelsBodySchema,
} from '@mangostudio/shared/connectors';
import { ERROR_CODES, type ApiErrorResponse } from '@mangostudio/shared/errors';
import type { Connector, ConnectorStatus } from '@mangostudio/shared';
import { requireAuth } from '../../../plugins/auth-middleware';
import { listConnectors } from '../application/list-connectors';
import { addConnector, ConnectorValidationError } from '../application/add-connector';
import {
  removeConnector,
  ConnectorNotFoundError,
  ConnectorOwnershipError,
} from '../application/remove-connector';
import { updateConnectorModels } from '../application/update-connector-models';
import {
  InvalidGeminiApiKeyError,
  GeminiValidationUnavailableError,
} from '../../../services/gemini';
import { SecretStorageUnavailableError } from '../../../services/secret-store';
import {
  OpenAIAuthError,
  OpenAIConfigError,
  UnsafeBaseUrlError,
} from '../infrastructure/provider-validation';

export function handleConnectorError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof ConnectorValidationError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  if (error instanceof ConnectorNotFoundError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  if (error instanceof ConnectorOwnershipError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  if (error instanceof UnsafeBaseUrlError) {
    set.status = 422;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }

  if (error instanceof InvalidGeminiApiKeyError) {
    set.status = 422;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }

  if (error instanceof SecretStorageUnavailableError) {
    set.status = 503;
    return {
      error: 'OS secret storage is unavailable on this machine.',
      code: ERROR_CODES.PROVIDER_ERROR,
    };
  }

  if (error instanceof GeminiValidationUnavailableError) {
    set.status = 502;
    return { error: error.message, code: ERROR_CODES.PROVIDER_ERROR };
  }

  if (error instanceof OpenAIAuthError) {
    set.status = error.status;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }

  if (error instanceof OpenAIConfigError) {
    set.status = 422;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }

  console.error('[connectors] Unexpected error:', error);
  set.status = 500;
  return {
    error: error instanceof Error ? error.message : 'Unexpected connector error.',
    code: ERROR_CODES.INTERNAL,
  };
}

export const connectorRoutes = new Elysia()
  .use(requireAuth)

  .get('/connectors', async ({ user }): Promise<ConnectorStatus> => {
    return listConnectors(user?.id ?? '');
  })

  .post(
    '/connectors',
    async ({ body, set, user }): Promise<Connector | ApiErrorResponse> => {
      try {
        return await addConnector(user?.id ?? '', body);
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    { body: AddConnectorBodySchema }
  )

  .delete(
    '/connectors/:id',
    async ({ params, set, user }): Promise<{ success: true } | ApiErrorResponse> => {
      try {
        await removeConnector(user?.id ?? '', params.id);
        return { success: true };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    { params: t.Object({ id: t.String() }) }
  )

  .put(
    '/connectors/:id/models',
    async ({ params, body, set, user }): Promise<{ success: true } | ApiErrorResponse> => {
      try {
        await updateConnectorModels(user?.id ?? '', params.id, body.enabledModels);
        return { success: true };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: UpdateConnectorModelsBodySchema,
    }
  );
