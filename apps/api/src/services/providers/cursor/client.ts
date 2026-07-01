/**
 * Cursor SDK client helpers for model discovery and API key validation.
 */

import type { ModelInfo } from '../types';
import { getCursorFallbackModels, toCursorModelInfo } from './model-catalog';

interface CursorModelListEntry {
  id?: string;
}

function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  return import('@cursor/sdk');
}

export async function fetchCursorModels(params: { apiKey: string }): Promise<ModelInfo[]> {
  try {
    const { Cursor } = await loadCursorSdk();
    const models = await Cursor.models.list({ apiKey: params.apiKey.trim() });
    const ids = (models as CursorModelListEntry[])
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) return getCursorFallbackModels();
    return ids.map(toCursorModelInfo).sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch {
    return getCursorFallbackModels();
  }
}

export async function validateCursorApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new CursorApiError('Cursor API key is empty.');
  }

  try {
    const { Cursor } = await loadCursorSdk();
    await Cursor.models.list({ apiKey: trimmed });
  } catch (error) {
    throw new CursorApiError(
      error instanceof Error ? error.message : 'Cursor API key validation failed.'
    );
  }
}

export class CursorApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorApiError';
  }
}
