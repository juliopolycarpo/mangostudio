/**
 * Create and revoke mutations for the external API key list.
 */

import type { CreateApiKeyBody } from '@mangostudio/shared/api-keys';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createApiKey, revokeApiKey } from '../api';
import { apiKeysKeys } from '../queries';

function useInvalidateApiKeys() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: apiKeysKeys.list() });
}

export function useCreateApiKey() {
  const invalidate = useInvalidateApiKeys();
  return useMutation({
    mutationFn: (body: CreateApiKeyBody) => createApiKey(body),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidateApiKeys();
  return useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => invalidate(),
  });
}
