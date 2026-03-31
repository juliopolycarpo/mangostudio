/**
 * Unified model catalog route.
 */

import { Elysia } from 'elysia';
import type { ModelCatalogResponse } from '@mangostudio/shared';
import { getUnifiedModelCatalog } from '../../services/providers/catalog';
import { requireAuth } from '../../plugins/auth-middleware';

export const modelRoutes = new Elysia()
  .use(requireAuth)

  /** Returns the unified model catalog across all providers. */
  .get('/models', async ({ user }): Promise<ModelCatalogResponse> => {
    return getUnifiedModelCatalog(user?.id ?? '');
  });
