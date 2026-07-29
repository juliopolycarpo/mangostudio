import type {
  CreateApiKeyBody,
  CreateApiKeyResponse,
  ListApiKeysResponse,
} from '@mangostudio/shared/api-keys';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

/**
 * Eden Treaty currently types the hyphenated `/api-keys` plugin's error
 * channel as `{}` even though the runtime payload carries `.value`. Narrow
 * through this helper so callers stay consistent with other feature APIs.
 */
function throwApiError(error: unknown): never {
  const value =
    error && typeof error === 'object' && 'value' in error
      ? (error as { value: unknown }).value
      : error;
  throw new ApiError(value);
}

export async function listApiKeys(): Promise<ListApiKeysResponse> {
  const { data, error } = await client.api['api-keys'].get();
  if (error) throwApiError(error);
  return data as ListApiKeysResponse;
}

export async function createApiKey(body: CreateApiKeyBody): Promise<CreateApiKeyResponse> {
  const { data, error } = await client.api['api-keys'].post(body);
  if (error) throwApiError(error);
  return data as CreateApiKeyResponse;
}

export async function revokeApiKey(id: string): Promise<void> {
  const { error } = await client.api['api-keys']({ id }).delete();
  if (error) throwApiError(error);
}
