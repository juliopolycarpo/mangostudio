/**
 * The library's re-check: a forced read of every location, then every library
 * query refetches what it shows.
 *
 * One action for the whole section. It is a superset of refetching the page
 * that is open — the hub's cached scan is bypassed rather than asked again — so
 * the tabs share one button instead of each offering a cheaper, weaker twin.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rescanLibrary } from '../api';
import { libraryKeys } from '../queries';

export function useLibraryRescan(environmentId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => rescanLibrary(true, environmentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });
}
