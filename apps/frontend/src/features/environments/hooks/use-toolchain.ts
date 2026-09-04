/**
 * Writes a toolchain pin for one environment: a specific installation's path,
 * or `auto` to go back to what a login shell would resolve.
 *
 * The write changes two things the environments surface has already cached:
 * the environments list, which is where a card reads the current selection
 * from, and that environment's runtime statuses, which the summary line on
 * the entities overview reads. Both are invalidated on success rather than
 * patched in place — the hub is the source of truth for what it will actually
 * spawn a process with.
 */

import type { ToolchainChoice, ToolchainRuntimeId } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateToolchain } from '../api';
import { environmentKeys } from '../queries';

export interface ToolchainSelectionInput {
  readonly runtimeId: ToolchainRuntimeId;
  readonly choice: ToolchainChoice;
}

/** Builds the partial body the route expects: only the runtime that changed. */
function toolchainBody(input: ToolchainSelectionInput) {
  return { [input.runtimeId]: input.choice };
}

export function useUpdateToolchainMutation(environmentId: string = LOCAL_ENVIRONMENT_ID) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ToolchainSelectionInput) =>
      updateToolchain(environmentId, toolchainBody(input)),
    onSuccess: async () => {
      // Both refetches are independent, and `invalidateQueries` resolves only
      // once the matching active queries have settled — the runtimes one is a
      // `probing.runtimes` round trip with a 15s hub deadline. Awaited in
      // series it would not even start until the entities refetch finished,
      // and the user is watching the card that fired this.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: environmentKeys.entities() }),
        queryClient.invalidateQueries({ queryKey: environmentKeys.runtimes(environmentId) }),
      ]);
    },
  });
}
