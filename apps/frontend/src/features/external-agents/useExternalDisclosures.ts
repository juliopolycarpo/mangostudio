/**
 * Which vendors this user has been told about, and when.
 *
 * Stored per user in app settings rather than per chat: the disclosure is about
 * the vendor, not the conversation, and re-asking on every new chat would train
 * people to dismiss it — which is the failure mode a Terms-of-Service notice
 * cannot afford.
 */

import type {
  ExternalAgentCapabilities,
  ExternalAgentDisclosure,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_DISCLOSURE_VERSION,
  externalCapabilitiesFingerprint,
} from '@mangostudio/shared/external-agents';
import { useCallback, useMemo } from 'react';
import { useApp } from '@/lib/app-context';

export interface ExternalDisclosuresView {
  forTarget: (targetId: ExternalAgentTargetId) => ExternalAgentDisclosure | undefined;
  accept: (targetId: ExternalAgentTargetId, capabilities: ExternalAgentCapabilities) => void;
}

export function useExternalDisclosures(): ExternalDisclosuresView {
  const app = useApp();
  const settings = app.settings;
  const disclosures = settings.externalAgentSettings.disclosures;

  const accept = useCallback(
    (targetId: ExternalAgentTargetId, capabilities: ExternalAgentCapabilities) => {
      settings.updateExternalAgentSettings({
        disclosures: {
          ...disclosures,
          [targetId]: {
            version: EXTERNAL_DISCLOSURE_VERSION,
            acceptedAt: Date.now(),
            // What the vendor claimed at the moment of consent, so a materially
            // different claim later asks again rather than inheriting an
            // agreement to something else.
            capabilitiesFingerprint: externalCapabilitiesFingerprint(capabilities),
          },
        },
      });
    },
    [disclosures, settings]
  );

  return useMemo(
    () => ({ forTarget: (targetId) => disclosures[targetId], accept }),
    [disclosures, accept]
  );
}
