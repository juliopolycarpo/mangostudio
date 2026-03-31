/**
 * Gemini-specific backward-compatible alias routes.
 */

import { Elysia, t } from 'elysia';
import type { Connector, ConnectorStatus, ModelCatalogResponse } from '@mangostudio/shared';
import {
  getGeminiSecretStatus,
  addGeminiConnector,
  deleteGeminiConnector,
  updateConnectorModels,
  refreshGeminiModelCatalog,
} from '../../services/gemini';
import { getUnifiedModelCatalog, invalidateUnifiedCatalog } from '../../services/providers/catalog';
import { connectorBodySchema, handleSecretRouteError } from './connectors';
import { requireAuth } from '../../plugins/auth-middleware';

export const geminiAliasRoutes = new Elysia()
  .use(requireAuth)

  /** Returns Gemini connectors only. */
  .get('/secrets/gemini', async ({ user }): Promise<ConnectorStatus> => {
    return getGeminiSecretStatus(user?.id ?? '');
  })

  /** Returns the Gemini model catalog (also available via unified /models). */
  .get('/models/gemini', async ({ user }): Promise<ModelCatalogResponse> => {
    return getUnifiedModelCatalog(user?.id ?? '');
  })

  /** Adds a new Gemini connector (alias). */
  .post(
    '/connectors/gemini',
    async ({ body, set, user }): Promise<Connector | { error: string }> => {
      try {
        const connector = await addGeminiConnector(user?.id ?? '', body);
        await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
        invalidateUnifiedCatalog(user?.id ?? '');
        return connector;
      } catch (error) {
        return handleSecretRouteError(error, set);
      }
    },
    { body: connectorBodySchema }
  )

  /** Deletes a Gemini connector (alias). */
  .delete(
    '/connectors/gemini/:id',
    async ({ params, set, user }): Promise<{ success: true } | { error: string }> => {
      try {
        await deleteGeminiConnector(user?.id ?? '', params.id);
        await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
        invalidateUnifiedCatalog(user?.id ?? '');
        console.log(`[settings] DEL connector ${params.id}`);
        return { success: true };
      } catch (error) {
        return handleSecretRouteError(error, set);
      }
    },
    { params: t.Object({ id: t.String() }) }
  )

  /** Updates enabled models for a Gemini connector (alias). */
  .put(
    '/connectors/gemini/:id/models',
    async ({ params, body, set, user }): Promise<{ success: true } | { error: string }> => {
      try {
        await updateConnectorModels(user?.id ?? '', params.id, body.enabledModels);
        invalidateUnifiedCatalog(user?.id ?? '');
        return { success: true };
      } catch (error) {
        return handleSecretRouteError(error, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ enabledModels: t.Array(t.String()) }),
    }
  );
