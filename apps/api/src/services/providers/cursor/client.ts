/**
 * Cursor client helpers for model discovery and API key validation.
 */

import { requestNodeSidecar } from '../core/node-sidecar/single-call';
import { NodeSidecarError } from '../core/node-sidecar/spawn-sidecar';
import type { ModelInfo } from '../types';
import { getCursorFallbackModels, toCursorModelInfo } from './model-catalog';
import { detectCursorRuntimeAvailability } from './runtime-availability';
import { resolveCursorRuntimeUnavailableMessage } from './runtime-reason';
import { describeCursorSpawnError, resolveCursorSidecarScriptPath } from './sidecar-process';

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

interface CursorSidecarClientOptions {
  timeoutMs?: number;
  killGraceMs?: number;
}

type CursorClientSidecarRequest =
  | {
      type: 'list_models';
      apiKey: string;
    }
  | {
      type: 'validate_api_key';
      apiKey: string;
    };

type CursorClientSidecarResponse =
  | {
      type: 'models';
      models?: CursorModelListEntry[];
    }
  | {
      type: 'ok';
    }
  | {
      type: 'error';
      message?: string;
      content?: string;
      status?: number;
      isRetryable?: boolean;
    };

const CURSOR_SIDECAR_RPC_TIMEOUT_MS = 30_000;
const CURSOR_SIDECAR_RPC_KILL_GRACE_MS = 1_000;

function getCursorErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
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

function parseCursorSidecarRpcError(
  response: Extract<CursorClientSidecarResponse, { type: 'error' }>
): CursorSidecarRpcError {
  return new CursorSidecarRpcError(
    response.message ?? response.content ?? 'Cursor sidecar request failed.',
    {
      status: response.status,
      isRetryable: response.isRetryable,
    }
  );
}

function isCursorSidecarResponse(
  value: Record<string, unknown>
): value is CursorClientSidecarResponse {
  const type = value.type;
  if (type === 'models' || type === 'ok' || type === 'error') {
    return true;
  }
  return false;
}

async function requestCursorSidecar(
  request: CursorClientSidecarRequest,
  options: CursorSidecarClientOptions = {}
): Promise<CursorClientSidecarResponse> {
  const runtime = await detectCursorRuntimeAvailability();
  if (!runtime.available || !runtime.nodePath) {
    throw new CursorValidationUnavailableError(resolveCursorRuntimeUnavailableMessage(runtime));
  }

  const timeoutMs = options.timeoutMs ?? CURSOR_SIDECAR_RPC_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? CURSOR_SIDECAR_RPC_KILL_GRACE_MS;

  try {
    const response = await requestNodeSidecar<CursorClientSidecarResponse>({
      nodePath: runtime.nodePath,
      sidecarScriptPath: runtime.sidecarScriptPath ?? resolveCursorSidecarScriptPath(),
      request,
      timeoutMs,
      killGraceMs,
      sidecarLabel: 'Cursor',
      isResponse: isCursorSidecarResponse,
      ignoreExitCodeWhen: (response) => response.type === 'error',
      describeSpawnError: describeCursorSpawnError,
    });
    if (response.type === 'error') throw parseCursorSidecarRpcError(response);
    return response;
  } catch (error) {
    if (error instanceof NodeSidecarError) {
      throw new CursorValidationUnavailableError(error.message);
    }
    throw error;
  }
}

export async function fetchCursorModels(
  params: { apiKey: string },
  options: CursorSidecarClientOptions = {}
): Promise<ModelInfo[]> {
  try {
    const response = await requestCursorSidecar(
      { type: 'list_models', apiKey: params.apiKey.trim() },
      options
    );
    if (response.type !== 'models') {
      throw new CursorValidationUnavailableError('Cursor sidecar returned no model list.');
    }

    const models = Array.isArray(response.models) ? response.models : [];
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
      throw new CursorApiError(getCursorErrorMessage(error, 'Cursor model discovery failed.'), {
        cause: error,
      });
    }
    return getCursorFallbackModels();
  }
}

export async function validateCursorApiKey(
  apiKey: string,
  options: CursorSidecarClientOptions = {}
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new CursorApiError('Cursor API key is empty.');
  }

  try {
    const response = await requestCursorSidecar(
      { type: 'validate_api_key', apiKey: trimmed },
      options
    );
    if (response.type !== 'ok') {
      throw new CursorValidationUnavailableError('Cursor sidecar did not confirm validation.');
    }
  } catch (error) {
    if (error instanceof CursorApiError) throw error;
    if (isCursorAuthError(error)) {
      throw new CursorApiError(getCursorErrorMessage(error, 'Cursor rejected the API key.'), {
        cause: error,
      });
    }
    throw new CursorValidationUnavailableError(
      getCursorErrorMessage(error, 'Unable to validate the Cursor API key right now. Try again.')
    );
  }
}

class CursorSidecarRpcError extends Error implements CursorSdkErrorLike {
  readonly status?: number;
  readonly isRetryable?: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      isRetryable?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'CursorSidecarRpcError';
    this.status = options.status;
    this.isRetryable = options.isRetryable;
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
