/**
 * Cursor SDK client helpers for model discovery and API key validation.
 */

import type { ModelInfo } from '../types';
import { getCursorFallbackModels, toCursorModelInfo } from './model-catalog';

interface CursorModelListEntry {
  id?: string;
  parameters?: Array<{
    id: string;
    values: Array<{ value: string }>;
  }>;
}

interface CursorSdkErrorLike {
  status?: number;
  statusCode?: number;
  isRetryable?: boolean;
}

function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  return import('@cursor/sdk');
}

function getCursorErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as CursorSdkErrorLike;
  return candidate.status ?? candidate.statusCode;
}

function isCursorAuthError(error: unknown): boolean {
  const status = getCursorErrorStatus(error);
  return status === 401 || status === 403;
}

function canUseCursorModelFallback(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;

  const candidate = error as CursorSdkErrorLike;
  if (candidate.isRetryable === true) return true;
  if (candidate.isRetryable === false) return false;

  const status = getCursorErrorStatus(error);
  if (status === undefined) return true;
  if (isCursorAuthError(error)) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function fetchCursorModels(params: { apiKey: string }): Promise<ModelInfo[]> {
  try {
    const { Cursor } = await loadCursorSdk();
    const models = (await Cursor.models.list({
      apiKey: params.apiKey.trim(),
    })) as CursorModelListEntry[];
    const discovered = models
      .map((entry) => {
        const id = entry.id?.trim();
        if (!id) return null;
        return toCursorModelInfo(id, entry.parameters);
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (discovered.length === 0) {
      throw new CursorApiError('Cursor returned no models for this API key.');
    }
    return discovered.sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch (error) {
    if (error instanceof CursorApiError) throw error;
    if (!canUseCursorModelFallback(error)) {
      throw new CursorApiError(
        error instanceof Error ? error.message : 'Cursor model discovery failed.',
        { cause: error }
      );
    }
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
    if (error instanceof CursorApiError) throw error;
    if (isCursorAuthError(error)) {
      throw new CursorApiError(
        error instanceof Error ? error.message : 'Cursor rejected the API key.',
        { cause: error }
      );
    }
    throw new CursorValidationUnavailableError(error instanceof Error ? error.message : undefined);
  }
}

export class CursorApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorApiError';
  }
}

export class CursorValidationUnavailableError extends Error {
  constructor(message = 'Unable to validate the Cursor API key right now. Try again.') {
    super(message);
    this.name = 'CursorValidationUnavailableError';
  }
}
