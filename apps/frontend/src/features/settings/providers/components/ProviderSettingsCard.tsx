/**
 * Provider settings card — a compact card showing provider info and capability badges.
 */

import type { ProviderSettingsDescriptor } from '@mangostudio/shared/provider-settings';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { EFFORT_LABEL_KEYS } from '../constants';

interface ProviderSettingsCardProps {
  descriptor: ProviderSettingsDescriptor;
}

/**
 * The card is a link's face, so the hover fill lives on the link's `group`: the
 * row answers the pointer with `fill-hover` and the chevron says it leads
 * somewhere.
 */
export function ProviderSettingsCard({ descriptor }: ProviderSettingsCardProps) {
  const { t } = useI18n();
  const providerName = t.providers[descriptor.provider] ?? descriptor.displayName;
  const reasoningLabel = descriptor.reasoning.supportedEfforts
    .map((e) => t.thinking[EFFORT_LABEL_KEYS[e] as keyof typeof t.thinking])
    .join(', ');

  return (
    <div className="flex items-center gap-4 rounded-md border border-stroke bg-surface p-4 transition-colors group-hover:bg-fill-hover">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">{providerName}</h3>
          {descriptor.deprecated ? (
            <Badge variant="warning">{t.settings.providers.deprecatedBadge}</Badge>
          ) : null}
        </div>
        {/* TODO: connectorCount / enabledModelCount when the API returns them */}
        <p className="text-xs text-fg-muted">
          {descriptor.deprecated ? t.settings.providers.deprecatedNote : reasoningLabel}
        </p>
        {descriptor.deprecated ? null : (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {descriptor.reasoning.thinkingToggleSupported && (
              <Badge>{t.settings.providers.capabilityThinking}</Badge>
            )}
            {descriptor.toolUseSupported && <Badge>{t.settings.providers.capabilityTools}</Badge>}
            {descriptor.promptCachingSupported && (
              <Badge>{t.settings.providers.capabilityCaching}</Badge>
            )}
          </div>
        )}
      </div>
      <ChevronRight size={ICON_MD} className="shrink-0 text-fg-subtle" aria-hidden="true" />
    </div>
  );
}
