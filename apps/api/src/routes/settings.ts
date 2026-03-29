/**
 * Settings routes for provider-backed secrets and connectors.
 */

import { Elysia, t } from 'elysia';
import type {
  DeleteGeminiSecretResponse,
  GeminiModelCatalogResponse,
  GeminiSecretStatus,
  Connector,
} from '@mangostudio/shared';
import {
  getGeminiSecretStatus,
  addGeminiConnector,
  deleteGeminiConnector,
  updateConnectorModels,
  getGeminiModelCatalog,
  refreshGeminiModelCatalog,
  InvalidGeminiApiKeyError,
  GeminiValidationUnavailableError,
} from '../services/gemini';
import { SecretStorageUnavailableError } from '../services/secret-store';
import { requireAuth } from '../plugins/auth-middleware';

function handleSecretRouteError(
  error: unknown,
  set: { status?: number | string }
): { error: string } {
  if (error instanceof InvalidGeminiApiKeyError) {
    set.status = 422;
    return { error: error.message };
  }

  if (error instanceof SecretStorageUnavailableError) {
    set.status = 503;
    return { error: 'OS secret storage is unavailable on this machine.' };
  }

  if (error instanceof GeminiValidationUnavailableError) {
    set.status = 502;
    return { error: error.message };
  }

  console.error('[settings] Unexpected secret route error:', error);
  set.status = 500;
  return { error: error instanceof Error ? error.message : 'Unexpected secret settings error.' };
}

export const settingsRoutes = (app: Elysia) =>
  app.group('/settings', (app) =>
    // App-wide settings for the default user
    app
      .use(requireAuth)
      /** Returns all Gemini connectors for the authenticated user. */
      .get('/secrets/gemini', async ({ user }): Promise<GeminiSecretStatus> => {
        return getGeminiSecretStatus(user?.id ?? '');
      })

      /** Returns the cached Gemini model catalog snapshot for the user. */
      .get('/models/gemini', async ({ user }): Promise<GeminiModelCatalogResponse> => {
        return getGeminiModelCatalog(user?.id ?? '');
      })

      /** Adds a new Gemini connector for the user. */
      .post(
        '/connectors/gemini',
        async ({ body, set, user }): Promise<Connector | { error: string }> => {
          try {
            const connector = await addGeminiConnector(user?.id ?? '', body);
            await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
            return connector;
          } catch (error) {
            return handleSecretRouteError(error, set);
          }
        },
        {
          body: t.Object({
            name: t.String(),
            apiKey: t.String(),
            source: t.Union([
              t.Literal('bun-secrets'),
              t.Literal('environment'),
              t.Literal('config-file'),
              t.Literal('none'),
            ]),
            provider: t.Optional(
              t.Union([t.Literal('gemini'), t.Literal('openai-compatible'), t.Literal('anthropic')])
            ),
            baseUrl: t.Optional(t.String()),
          }),
        }
      )

      /** Deletes a specific Gemini connector for the user. */
      .delete(
        '/connectors/gemini/:id',
        async ({ params, set, user }): Promise<DeleteGeminiSecretResponse | { error: string }> => {
          try {
            await deleteGeminiConnector(user?.id ?? '', params.id);
            await refreshGeminiModelCatalog(user?.id ?? '', 'secret-updated');
            console.log(`[settings] DEL connector ${params.id}`);
            return { success: true };
          } catch (error) {
            return handleSecretRouteError(error, set);
          }
        },
        {
          params: t.Object({
            id: t.String(),
          }),
        }
      )

      /** Updates enabled models for a connector owned by the user. */
      .put(
        '/connectors/gemini/:id/models',
        async ({ params, body, set, user }): Promise<{ success: true } | { error: string }> => {
          try {
            await updateConnectorModels(user?.id ?? '', params.id, body.enabledModels);
            return { success: true };
          } catch (error) {
            return handleSecretRouteError(error, set);
          }
        },
        {
          params: t.Object({
            id: t.String(),
          }),
          body: t.Object({
            enabledModels: t.Array(t.String()),
          }),
        }
      )
  );
