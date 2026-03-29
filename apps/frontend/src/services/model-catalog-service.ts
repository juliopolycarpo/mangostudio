/* global fetch, console */
import type { ModelCatalogResponse } from '@mangostudio/shared';
import { EMPTY_MODEL_CATALOG } from '../utils/model-utils';

export async function fetchModelCatalog(): Promise<ModelCatalogResponse> {
  const response = await fetch('/api/settings/models');
  if (!response.ok) {
    throw new Error('Failed to load model catalog.');
  }
  return response.json();
}

export async function refreshModelCatalog(): Promise<ModelCatalogResponse> {
  try {
    return await fetchModelCatalog();
  } catch (error) {
    console.error('[settings] Failed to fetch model catalog', error);
    return {
      ...EMPTY_MODEL_CATALOG,
      configured: false,
      status: 'error',
      error: 'Failed to fetch model catalog.',
    };
  }
}
