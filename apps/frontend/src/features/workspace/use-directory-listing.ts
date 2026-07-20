import type { ListDirectoryResponse, ValidatePathResponse } from '@mangostudio/shared/workspaces';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const workspaceDirectoryKeys = {
  all: ['workspace-directories'] as const,
  listing: (path?: string) => [...workspaceDirectoryKeys.all, path ?? null] as const,
};

function directoryListingQueryOptions(path?: string) {
  return queryOptions({
    queryKey: workspaceDirectoryKeys.listing(path),
    queryFn: async () => {
      const query = path ? { path } : {};
      const { data, error } = await client.api.workspace.fs.get({ query });
      if (error) throw new ApiError(error.value);
      return data as ListDirectoryResponse;
    },
  });
}

export function useDirectoryListing(path: string | undefined, enabled: boolean) {
  return useQuery({ ...directoryListingQueryOptions(path), enabled });
}

export async function validateWorkspacePath(path: string): Promise<ValidatePathResponse> {
  const { data, error } = await client.api.workspace.fs.validate.post({ path });
  if (error) throw new ApiError(error.value);
  return data as ValidatePathResponse;
}
