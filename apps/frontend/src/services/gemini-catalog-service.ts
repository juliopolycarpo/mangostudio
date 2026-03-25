/* global fetch, console */
import type { GeminiModelCatalogResponse } from '@mangostudio/shared';
import { EMPTY_GEMINI_MODEL_CATALOG } from '../utils/gemini-models';

export async function fetchGeminiModelCatalog(): Promise<GeminiModelCatalogResponse> {
  const response = await fetch('/api/settings/models/gemini');
  if (!response.ok) {
    throw new Error('Failed to load Gemini model catalog.');
  }
  return response.json();
}

export async function refreshGeminiModelCatalog(): Promise<GeminiModelCatalogResponse> {
  try {
    const data = await fetchGeminiModelCatalog();
    return data;
  } catch (error) {
    console.error('[settings] Failed to fetch Gemini model catalog', error);
    return {
      ...EMPTY_GEMINI_MODEL_CATALOG,
      configured: false,
      status: 'error',
      error: 'Failed to fetch Gemini model catalog.',
    };
  }
}
