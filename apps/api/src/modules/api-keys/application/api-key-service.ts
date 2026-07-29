import {
  API_KEY_MAX_PER_USER,
  type ApiKeySummary,
  type CreateApiKeyBody,
  type CreateApiKeyResponse,
  type ListApiKeysResponse,
} from '@mangostudio/shared/api-keys';
import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import { isAPIError } from 'better-auth/api';
import {
  type ApiKeyPluginApi,
  type ApiKeyPluginRecord,
  getApiKeyApi,
  resolveApiKeyScope,
} from '../../../auth';

const SECONDS_PER_DAY = 86_400;
const userCreateTails = new Map<string, Promise<void>>();

export interface ApiKeyRequestContext {
  userId: string;
  headers: Headers;
}

export class ApiKeyServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode
  ) {
    super(message);
    this.name = 'ApiKeyServiceError';
  }
}

function toDateTime(value: Date): string {
  return value.toISOString();
}

function toNullableDateTime(value: Date | null): string | null {
  return value ? toDateTime(value) : null;
}

function toApiKeySummary(record: ApiKeyPluginRecord): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    scope: resolveApiKeyScope(record.metadata),
    start: record.start,
    createdAt: toDateTime(record.createdAt),
    expiresAt: toNullableDateTime(record.expiresAt),
    lastUsedAt: toNullableDateTime(record.lastRequest),
  };
}

async function listOwnedRecords(
  context: ApiKeyRequestContext,
  api: ApiKeyPluginApi
): Promise<ApiKeyPluginRecord[]> {
  const result = await api.listApiKeys({
    headers: context.headers,
    query: { sortBy: 'createdAt', sortDirection: 'desc' },
  });

  // Better Auth scopes this endpoint to the session user. Keep the owner
  // filter at the third-party boundary so an upstream regression cannot leak
  // another account's key metadata.
  return result.apiKeys.filter((key) => key.referenceId === context.userId);
}

async function serializeUserCreate<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = userCreateTails.get(userId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  userCreateTails.set(userId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (userCreateTails.get(userId) === tail) userCreateTails.delete(userId);
  }
}

export async function listApiKeys(
  context: ApiKeyRequestContext,
  api: ApiKeyPluginApi = getApiKeyApi()
): Promise<ListApiKeysResponse> {
  const records = await listOwnedRecords(context, api);
  return { keys: records.map(toApiKeySummary) };
}

export function createApiKey(
  context: ApiKeyRequestContext,
  body: CreateApiKeyBody,
  api: ApiKeyPluginApi = getApiKeyApi()
): Promise<CreateApiKeyResponse> {
  return serializeUserCreate(context.userId, async () => {
    const records = await listOwnedRecords(context, api);
    const activeKeyCount = records.filter(
      (key) => !key.expiresAt || key.expiresAt.getTime() > Date.now()
    ).length;

    if (activeKeyCount >= API_KEY_MAX_PER_USER) {
      throw new ApiKeyServiceError(
        'API key limit reached. Revoke a key before creating another.',
        400,
        ERROR_CODES.API_KEY_LIMIT_REACHED
      );
    }

    const created = await api.createApiKey({
      body: {
        userId: context.userId,
        name: body.name.trim(),
        metadata: { scope: body.scope },
        ...(body.expiresInDays !== undefined && {
          expiresIn: body.expiresInDays * SECONDS_PER_DAY,
        }),
      },
    });

    return { key: created.key, summary: toApiKeySummary(created) };
  });
}

export async function revokeApiKey(
  context: ApiKeyRequestContext,
  keyId: string,
  api: ApiKeyPluginApi = getApiKeyApi()
): Promise<void> {
  const records = await listOwnedRecords(context, api);
  if (!records.some((key) => key.id === keyId)) {
    throw new ApiKeyServiceError('API key not found.', 404, ERROR_CODES.NOT_FOUND);
  }

  try {
    const result = await api.deleteApiKey({
      body: { keyId },
      headers: context.headers,
    });
    if (!result.success) throw new Error('API key deletion did not succeed');
  } catch (error) {
    // The key may have been revoked between the owner check and deletion.
    if (isAPIError(error) && error.statusCode === 404) {
      throw new ApiKeyServiceError('API key not found.', 404, ERROR_CODES.NOT_FOUND);
    }
    throw error;
  }
}
