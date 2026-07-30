import type {
  CreateApiKeyBody,
  CreateApiKeyResponse,
  ListApiKeysResponse,
} from '@mangostudio/shared/api-keys';
import { client } from '@/lib/api-client';
import { throwApiError } from '@/lib/utils';

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
