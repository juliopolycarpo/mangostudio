/**
 * Which vendors this user has been told about, as the server records it.
 *
 * Previously this lived in app settings and the client decided, from a stored
 * fingerprint, whether to show the modal. That was never a gate — the external
 * API sends the same conversation to the same company and never consulted it —
 * so the decision moved server-side, and this hook is now a view of that record
 * rather than a second copy of the rule.
 *
 * The consequence worth naming: **nothing here decides anything**. Whether a
 * vendor still needs the notice arrives on the descriptor as
 * `unavailableReason: 'disclosure-required'`, computed from the same row the
 * turn-start refusal reads. A client-side re-derivation would be a second rule
 * to keep in sync, and the two disagreeing would mean either a dialog nobody can
 * satisfy or an agent the selector offers and the server refuses.
 */

import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  acknowledgeExternalDisclosure,
  type ExternalDisclosureRecord,
  listExternalDisclosures,
  revokeExternalDisclosure,
} from '@/services/external-agent-service';

const DISCLOSURES_KEY = ['external-agent-disclosures'] as const;

export interface ExternalDisclosuresView {
  readonly records: readonly ExternalDisclosureRecord[];
  readonly isLoading: boolean;
  forTarget: (targetId: ExternalAgentTargetId) => ExternalDisclosureRecord | undefined;
  /**
   * Resolves once the acknowledgement is stored, and rejects when it is not.
   *
   * The caller has to wait: activating the vendor is what sends the user's
   * conversation to a third party, and doing that on the strength of a write
   * still in flight means a failed write leaves data already sent with no record
   * that the notice was ever shown.
   */
  accept: (targetId: ExternalAgentTargetId, environmentId: string) => Promise<void>;
  /** Withdraws it. The server also stops whatever is running for this user. */
  revoke: (targetId: ExternalAgentTargetId) => Promise<void>;
}

export function useExternalDisclosures(): ExternalDisclosuresView {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: DISCLOSURES_KEY,
    queryFn: listExternalDisclosures,
  });

  // Both mutations invalidate the agent list as well as this one: an
  // acknowledgement clears `disclosure-required` from a descriptor, and a
  // revocation puts it back, so a selector rendered from a stale list would
  // offer an agent the server has just started refusing.
  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: DISCLOSURES_KEY }),
      queryClient.invalidateQueries({ queryKey: ['external-agents'] }),
    ]);
  }, [queryClient]);

  const acceptMutation = useMutation({
    mutationFn: ({ targetId, environmentId }: { targetId: string; environmentId: string }) =>
      acknowledgeExternalDisclosure(targetId, environmentId),
    onSuccess: invalidate,
  });

  const revokeMutation = useMutation({
    mutationFn: (targetId: string) => revokeExternalDisclosure(targetId),
    onSuccess: invalidate,
  });

  const records = query.data ?? [];
  return {
    records,
    isLoading: query.isLoading,
    forTarget: (targetId) => records.find((record) => record.targetId === targetId),
    accept: async (targetId, environmentId) => {
      await acceptMutation.mutateAsync({ targetId, environmentId });
    },
    revoke: async (targetId) => {
      await revokeMutation.mutateAsync(targetId);
    },
  };
}
