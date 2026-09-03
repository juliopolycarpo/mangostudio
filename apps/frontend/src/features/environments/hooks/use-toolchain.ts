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

import type { ToolchainChoice } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateToolchain } from '../api';
import type { ToolchainRuntimeId } from '../format';
import { environmentKeys } from '../queries';

export interface ToolchainSelectionInput {
  readonly runtimeId: ToolchainRuntimeId;
  readonly choice: ToolchainChoice;
}

/** Builds the partial body the route expects: only the runtime that changed. */
function toolchainBody(input: ToolchainSelectionInput) {
  return input.runtimeId === 'node' ? { node: input.choice } : { bun: input.choice };
}

export function useUpdateToolchainMutation(environmentId: string = LOCAL_ENVIRONMENT_ID) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ToolchainSelectionInput) =>
      updateToolchain(environmentId, toolchainBody(input)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
      await queryClient.invalidateQueries({ queryKey: environmentKeys.runtimes(environmentId) });
    },
  });
}
