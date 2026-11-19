/**
 * The folders this user has trusted a vendor to load configuration from, as the
 * server records them.
 *
 * Like the disclosure record, this is a view and not a second copy of the rule:
 * whether a send needs the trust dialog is the server's answer on the send, and
 * nothing here predicts it. Withdrawing a grant only deletes the row, so the
 * cost of getting it wrong is one more dialog.
 */

import type {
  ExternalWorkspaceTrust,
  ExternalWorkspaceTrustRevokeBody,
} from '@mangostudio/shared/external-agents';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  listExternalWorkspaceTrust,
  revokeExternalWorkspaceTrust,
} from '@/services/external-agent-service';

const WORKSPACE_TRUST_KEY = ['external-workspace-trust'] as const;

export interface ExternalWorkspaceTrustView {
  readonly grants: readonly ExternalWorkspaceTrust[];
  readonly isLoading: boolean;
  /** Resolves once the server has dropped the grant, and rejects when it has not. */
  revoke: (grant: ExternalWorkspaceTrustRevokeBody) => Promise<void>;
}

export function useExternalWorkspaceTrust(): ExternalWorkspaceTrustView {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: WORKSPACE_TRUST_KEY,
    queryFn: listExternalWorkspaceTrust,
  });

  const revokeMutation = useMutation({
    mutationFn: revokeExternalWorkspaceTrust,
    // Refetched even when the revoke failed: a 404 means another tab already
    // removed it, and the list should stop showing a grant that is gone.
    onSettled: () => queryClient.invalidateQueries({ queryKey: WORKSPACE_TRUST_KEY }),
  });

  return {
    grants: query.data ?? [],
    isLoading: query.isLoading,
    revoke: async (grant) => {
      await revokeMutation.mutateAsync(grant);
    },
  };
}
