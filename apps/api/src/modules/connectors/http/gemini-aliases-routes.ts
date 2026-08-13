/**
 * Gemini-specific backward-compatible alias routes.
 * Delegates to existing Gemini service for legacy API consumers.
 */

import type { Connector, ConnectorStatus, ModelCatalogResponse } from '@mangostudio/shared';
import {
  AddConnectorBodySchema,
  UpdateConnectorModelsBodySchema,
} from '@mangostudio/shared/connectors';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { createDiagnosticLogger } from '../../../lib/logger';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  addGeminiConnector,
  deleteGeminiConnector,
  getGeminiSecretStatus,
  refreshGeminiModelCatalog,
  updateConnectorModels,
} from '../../../services/gemini';
import {
  getUnifiedModelCatalog,
  invalidateUnifiedCatalog,
} from '../../../services/providers/catalog';
import { invalidateProviderRoutingCache } from '../../../services/providers/core/provider-registry';
import { handleConnectorError } from './connectors-routes';

const connectorLogger = createDiagnosticLogger('connectors');

export const geminiAliasRoutes = new Elysia()
  .use(requireAuth)

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/secrets/gemini', async ({ user }): Promise<ConnectorStatus> => {
    return getGeminiSecretStatus(user?.id ?? '');
  })

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/models/gemini', async ({ user }): Promise<ModelCatalogResponse> => {
    return getUnifiedModelCatalog(user?.id ?? '');
  })

  .post(
    '/connectors/gemini',
    { body: AddConnectorBodySchema },
    async ({ body, set, user }): Promise<Connector | ApiErrorResponse> => {
      try {
        const connector = await addGeminiConnector(user?.id ?? '', body);
        await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
        invalidateUnifiedCatalog(user?.id ?? '');
        invalidateProviderRoutingCache(user?.id ?? '');
        return connector;
      } catch (error) {
        return handleConnectorError(error, set);
      }
    }
  )

  .delete(
    '/connectors/gemini/:id',
    { params: t.Object({ id: t.String() }) },
    async ({ params, set, user }): Promise<{ success: true } | ApiErrorResponse> => {
      try {
        await deleteGeminiConnector(user?.id ?? '', params.id);
        await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
        invalidateUnifiedCatalog(user?.id ?? '');
        invalidateProviderRoutingCache(user?.id ?? '');
        connectorLogger.info('connector_deleted', { id: params.id, provider: 'gemini' });
        return { success: true };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    }
  )

  .put(
    '/connectors/gemini/:id/models',
    {
      params: t.Object({ id: t.String() }),
      body: UpdateConnectorModelsBodySchema,
    },
    async ({ params, body, set, user }): Promise<{ success: true } | ApiErrorResponse> => {
      try {
        await updateConnectorModels(user?.id ?? '', params.id, body.enabledModels);
        invalidateUnifiedCatalog(user?.id ?? '');
        invalidateProviderRoutingCache(user?.id ?? '');
        return { success: true };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    }
  );
