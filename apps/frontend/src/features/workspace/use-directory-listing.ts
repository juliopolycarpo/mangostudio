import type { ListDirectoryResponse, ValidatePathResponse } from '@mangostudio/shared/workspaces';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const workspaceDirectoryKeys = {
  all: ['workspace-directories'] as const,
  listing: (path?: string, scope?: DirectoryScope) =>
    [
      ...workspaceDirectoryKeys.all,
      scope?.chatId ?? null,
      scope?.environmentId ?? null,
      path ?? null,
    ] as const,
};

/**
 * Which machine to browse. A chat names it through its own environment; an
 * environment names it directly, for a picker opened before any chat exists.
 * The endpoint refuses both at once, so callers pass one.
 */
export interface DirectoryScope {
  readonly chatId?: string;
  readonly environmentId?: string;
}

function scopeQuery(scope: DirectoryScope | undefined): DirectoryScope {
  if (scope?.chatId) return { chatId: scope.chatId };
  return scope?.environmentId ? { environmentId: scope.environmentId } : {};
}

function directoryListingQueryOptions(path?: string, scope?: DirectoryScope) {
  return queryOptions({
    queryKey: workspaceDirectoryKeys.listing(path, scope),
    queryFn: async () => {
      const query = {
        ...(path ? { path } : {}),
        ...scopeQuery(scope),
      };
      const { data, error } = await client.api.workspace.fs.get({ query });
      if (error) throw new ApiError(error.value);
      return data as ListDirectoryResponse;
    },
  });
}

export function useDirectoryListing(
  path: string | undefined,
  enabled: boolean,
  scope?: DirectoryScope
) {
  return useQuery({ ...directoryListingQueryOptions(path, scope), enabled });
}

export async function validateWorkspacePath(
  path: string,
  scope?: DirectoryScope
): Promise<ValidatePathResponse> {
  const { data, error } = await client.api.workspace.fs.validate.post({
    path,
    ...scopeQuery(scope),
  });
  if (error) throw new ApiError(error.value);
  return data as ValidatePathResponse;
}
