/**
 * Unified model catalog route.
 */

import type { ModelCatalogResponse } from '@mangostudio/shared';
import { Elysia } from 'elysia';
import { requireAuth } from '../../plugins/auth-middleware';
import { getUnifiedModelCatalog } from '../../services/providers/catalog';

export const modelRoutes = new Elysia()
  .use(requireAuth)

  /** Returns the unified model catalog across all providers. */
  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/models', async ({ user }): Promise<ModelCatalogResponse> => {
    return getUnifiedModelCatalog(user?.id ?? '');
  });
