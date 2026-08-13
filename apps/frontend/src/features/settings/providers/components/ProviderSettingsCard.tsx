/**
 * Provider settings card — a compact card showing provider info and capability badges.
 */

import type { ProviderSettingsDescriptor } from '@mangostudio/shared/provider-settings';
import { useI18n } from '@/hooks/use-i18n';
import { EFFORT_LABEL_KEYS } from '../constants';

interface ProviderSettingsCardProps {
  descriptor: ProviderSettingsDescriptor;
}

export function ProviderSettingsCard({ descriptor }: ProviderSettingsCardProps) {
  const { t } = useI18n();
  const providerName = t.providers[descriptor.provider] ?? descriptor.displayName;
  const reasoningLabel = descriptor.reasoning.supportedEfforts
    .map((e) => t.thinking[EFFORT_LABEL_KEYS[e] as keyof typeof t.thinking])
    .join(', ');

  return (
    <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-lowest p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-on-surface">{providerName}</h3>
            {descriptor.deprecated ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-200 border border-amber-500/20">
                {t.settings.providers.deprecatedBadge}
              </span>
            ) : null}
          </div>
          {/* TODO: connectorCount / enabledModelCount when the API returns them */}
          <p className="mt-0.5 text-xs text-on-surface-variant">
            {descriptor.deprecated ? t.settings.providers.deprecatedNote : reasoningLabel}
          </p>
        </div>
      </div>
      {descriptor.deprecated ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {descriptor.reasoning.thinkingToggleSupported && (
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-medium text-on-surface-variant">
              {t.settings.providers.capabilityThinking}
            </span>
          )}
          {descriptor.toolUseSupported && (
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-medium text-on-surface-variant">
              {t.settings.providers.capabilityTools}
            </span>
          )}
          {descriptor.promptCachingSupported && (
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-medium text-on-surface-variant">
              {t.settings.providers.capabilityCaching}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
