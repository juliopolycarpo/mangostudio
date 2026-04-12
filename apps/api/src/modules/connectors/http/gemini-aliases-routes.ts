/**
 * Gemini-specific backward-compatible alias routes.
 * Delegates to existing Gemini service for legacy API consumers.
 */

import { Elysia, t } from 'elysia';
import { UpdateConnectorModelsBodySchema } from '@mangostudio/shared/connectors';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type { Connector, ConnectorStatus, ModelCatalogResponse } from '@mangostudio/shared';
import {
  getGeminiSecretStatus,
  addGeminiConnector,
  deleteGeminiConnector,
  updateConnectorModels,
  refreshGeminiModelCatalog,
} from '../../../services/gemini';
import {
  getUnifiedModelCatalog,
  invalidateUnifiedCatalog,
} from '../../../services/providers/catalog';
import { AddConnectorBodySchema } from '@mangostudio/shared/connectors';
import { requireAuth } from '../../../plugins/auth-middleware';
import { handleConnectorError } from './connectors-routes';

export const geminiAliasRoutes = new Elysia()
  .use(requireAuth)

  .get('/secrets/gemini', async ({ user }): Promise<ConnectorStatus> => {
    return getGeminiSecretStatus(user?.id ?? '');
  })

  .get('/models/gemini', async ({ user }): Promise<ModelCatalogResponse> => {
    return getUnifiedModelCatalog(user?.id ?? '');
  })

  .post(
    '/connectors/gemini',
    async ({ body, set, user }): Promise<Connector | ApiErrorResponse> => {
      try {
        const connector = await addGeminiConnector(user?.id ?? '', body);
        await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
        invalidateUnifiedCatalog(user?.id ?? '');
        return connector;
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    { body: AddConnectorBodySchema }
  )

  .delete(
    '/connectors/gemini/:id',
    async ({ params, set, user }): Promise<{ success: true } | ApiErrorResponse> => {
      try {
        await deleteGeminiConnector(user?.id ?? '', params.id);
        await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
        invalidateUnifiedCatalog(user?.id ?? '');
        console.warn(`[connectors] DEL connector ${params.id}`);
        return { success: true };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    { params: t.Object({ id: t.String() }) }
  )

  .put(
    '/connectors/gemini/:id/models',
    async ({ params, body, set, user }): Promise<{ success: true } | ApiErrorResponse> => {
      try {
        await updateConnectorModels(user?.id ?? '', params.id, body.enabledModels);
        invalidateUnifiedCatalog(user?.id ?? '');
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
