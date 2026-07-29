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
    // The response carries the only plaintext copy of the key. React Query
    // parks a finished mutation's result in the MutationCache for `gcTime`
    // (5 minutes by default) even after the dialog unmounts, so drop it the
    // moment the dialog is done with it.
    gcTime: 0,
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidateApiKeys();
  return useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => invalidate(),
  });
}
