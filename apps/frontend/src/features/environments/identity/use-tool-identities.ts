/**
 * Tool identities for whatever surface is drawing an avatar.
 *
 * The registry is read far outside settings — environments cards, the library
 * matrix, MCP settings, the chat capability inspector — so liveness rides with
 * the query rather than with any one layout. The realtime client ref-counts its
 * topics, so several mounted consumers share one subscription.
 */

import { SETTINGS_TOPIC, type SettingsScope } from '@mangostudio/shared/realtime';
import type {
  ToolIdentityKind,
  ToolIdentityMap,
  ToolImageUpdate,
} from '@mangostudio/shared/tool-identity';
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { displayName, type ToolNameLookup } from '../format';
import { resetToolIdentity, updateToolIdentity, uploadToolIdentityImage } from './api';
import { toolIdentitiesQueryOptions, toolIdentityKeys } from './queries';
import { type ResolvedToolIdentity, resolveToolIdentity } from './resolve';

const EMPTY_IDENTITIES: ToolIdentityMap = {};

/** Refreshes the map when this or another tab renames something. */
function useToolIdentityRealtime(): void {
  const queryClient = useQueryClient();

  useRealtimeInvalidation(SETTINGS_TOPIC, (signal) => {
    // A subscription acknowledgement covers everything: events published while
    // the socket was down are not replayed, so the ack is the only barrier.
    const scopes: readonly SettingsScope[] | undefined =
      signal.type === 'subscribed'
        ? undefined
        : (signal.message.scopes as readonly SettingsScope[] | undefined);
    if (scopes && !scopes.includes('tool-identity')) return;

    void queryClient.invalidateQueries({ queryKey: toolIdentityKeys.all });
  });
}

export interface ToolIdentityResolver {
  readonly identities: ToolIdentityMap;
  /**
   * Effective name and monogram for one tool. `fallbackName` overrides the
   * i18n product name for subjects the dictionary does not know — an MCP
   * server's own name, for instance.
   */
  readonly resolve: (
    kind: ToolIdentityKind,
    id: string,
    fallbackName?: string
  ) => ResolvedToolIdentity;
  /** Custom names by subject key, for the React-free helpers in `format.ts`. */
  readonly lookup: ToolNameLookup;
}

export function useToolIdentities(): ToolIdentityResolver {
  const { t } = useI18n();
  const { data } = useQuery(toolIdentitiesQueryOptions());
  useToolIdentityRealtime();

  const identities = data?.identities ?? EMPTY_IDENTITIES;

  const resolve = useCallback(
    (kind: ToolIdentityKind, id: string, fallbackName?: string) =>
      resolveToolIdentity(identities, toolSubjectKey(kind, id), fallbackName ?? displayName(t, id)),
    [identities, t]
  );

  const lookup = useCallback<ToolNameLookup>(
    (subjectKey) => identities[subjectKey]?.displayName ?? undefined,
    [identities]
  );

  return useMemo(() => ({ identities, resolve, lookup }), [identities, resolve, lookup]);
}

/**
 * Saves a rename and whatever the image should become.
 *
 * Name and monogram are sent explicitly, `null` meaning "back to the derived
 * default", so the dialog never has to reason about which of them changed. The
 * image is the exception: an absent `image` means "leave it", which is what
 * lets a file upload be a second request without the first one wiping it.
 */
export function useSaveToolIdentity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: {
      subjectKey: string;
      displayName: string | null;
      monogram: string | null;
      image?: ToolImageUpdate | null;
      /** Uploaded after the update, since multipart cannot ride along with it. */
      imageFile?: File | null;
    }) => {
      await updateToolIdentity(variables.subjectKey, {
        displayName: variables.displayName,
        monogram: variables.monogram,
        ...(variables.image !== undefined && { image: variables.image }),
      });

      if (variables.imageFile) {
        await uploadToolIdentityImage(variables.subjectKey, variables.imageFile);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolIdentityKeys.all }),
  });
}

export function useResetToolIdentity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (subjectKey: string) => resetToolIdentity(subjectKey),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolIdentityKeys.all }),
  });
}
