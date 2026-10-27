/**
 * One provider in the provider settings list: its name and capabilities, the
 * reasoning efforts it offers, and a chevron to its own page.
 */

import type { ProviderSettingsDescriptor } from '@mangostudio/shared/provider-settings';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

import { EFFORT_LABEL_KEYS } from '../constants';

interface ProviderSettingsRowProps {
  descriptor: ProviderSettingsDescriptor;
}

/**
 * The row is the link: the whole width answers the pointer with `fill-hover`
 * and the chevron says it leads somewhere. It sits in the menu's divided card,
 * which clips the fill to its corners, so the focus ring is drawn inwards
 * (`-outline-offset-2`) where the clip cannot cut it off. The badges share the
 * name's line and wrap under it on a narrow screen, so a row is two lines.
 */
export function ProviderSettingsRow({ descriptor }: ProviderSettingsRowProps) {
  const { t } = useI18n();
  const s = t.settings.providers;
  const providerName = t.providers[descriptor.provider] ?? descriptor.displayName;
  const efforts = descriptor.reasoning.supportedEfforts
    .map((e) => t.thinking[EFFORT_LABEL_KEYS[e] as keyof typeof t.thinking])
    .join(', ');
  // The efforts are a list of bare words; say what they are the efforts of.
  const summary = descriptor.deprecated
    ? s.deprecatedNote
    : efforts
      ? `${s.reasoningEffort}: ${efforts}`
      : null;

  return (
    <Link
      to="/settings/providers/$provider"
      params={{ provider: descriptor.provider }}
      className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-fill-hover focus-visible:-outline-offset-2"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold text-fg">{providerName}</h3>
          {descriptor.deprecated ? (
            <Badge variant="warning">{s.deprecatedBadge}</Badge>
          ) : (
            <>
              {descriptor.reasoning.thinkingToggleSupported && (
                <Badge>{s.capabilityThinking}</Badge>
              )}
              {descriptor.toolUseSupported && <Badge>{s.capabilityTools}</Badge>}
              {descriptor.promptCachingSupported && <Badge>{s.capabilityCaching}</Badge>}
            </>
          )}
        </div>
        {summary ? <p className="text-xs text-fg-muted">{summary}</p> : null}
      </div>
      <ChevronRight size={ICON_MD} className="shrink-0 text-fg-subtle" aria-hidden="true" />
    </Link>
  );
}
