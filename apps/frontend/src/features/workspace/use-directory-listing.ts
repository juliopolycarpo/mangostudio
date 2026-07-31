import type { ListDirectoryResponse, ValidatePathResponse } from '@mangostudio/shared/workspaces';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const workspaceDirectoryKeys = {
  all: ['workspace-directories'] as const,
  listing: (path?: string, chatId?: string) =>
    [...workspaceDirectoryKeys.all, chatId ?? null, path ?? null] as const,
};

function directoryListingQueryOptions(path?: string, chatId?: string) {
  return queryOptions({
    queryKey: workspaceDirectoryKeys.listing(path, chatId),
    queryFn: async () => {
      const query = {
        ...(path ? { path } : {}),
        ...(chatId ? { chatId } : {}),
      };
      const { data, error } = await client.api.workspace.fs.get({ query });
      if (error) throw new ApiError(error.value);
      return data as ListDirectoryResponse;
    },
  });
}

export function useDirectoryListing(path: string | undefined, enabled: boolean, chatId?: string) {
  return useQuery({ ...directoryListingQueryOptions(path, chatId), enabled });
}

export async function validateWorkspacePath(
  path: string,
  chatId?: string
): Promise<ValidatePathResponse> {
  const { data, error } = await client.api.workspace.fs.validate.post({
    path,
    ...(chatId ? { chatId } : {}),
  });
  if (error) throw new ApiError(error.value);
  return data as ValidatePathResponse;
}
