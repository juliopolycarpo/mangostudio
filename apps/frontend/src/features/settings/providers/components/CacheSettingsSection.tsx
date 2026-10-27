/**
 * Prompt caching and provider compaction section. A provider without caching
 * keeps only the compaction switch, so the heading names what is actually there.
 */

import type {
  PromptCachePreference,
  UpdateProviderRuntimeSettingsBody,
} from '@mangostudio/shared/provider-settings';

import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';

interface CacheSettingsSectionProps {
  cachingSupported: boolean;
  form: UpdateProviderRuntimeSettingsBody;
  onChange: (form: UpdateProviderRuntimeSettingsBody) => void;
}

const CACHE_OPTIONS: { value: PromptCachePreference; labelKey: string }[] = [
  { value: 'auto', labelKey: 'cacheAuto' },
  { value: 'stable-prefix', labelKey: 'cacheStablePrefix' },
  { value: 'off', labelKey: 'cacheOff' },
];

export function CacheSettingsSection({
  cachingSupported,
  form,
  onChange,
}: CacheSettingsSectionProps) {
  const { t } = useI18n();
  const s = t.settings.providers;

  return (
    <SettingsSection title={cachingSupported ? s.sectionCache : s.sectionCompaction}>
      {cachingSupported && (
        <SettingsRow label={s.cachePreference} hint={s.cachePreferenceHint} layout="field">
          <Select
            id="cache-preference"
            value={form.promptCachePreference ?? 'auto'}
            onChange={(value) =>
              onChange({ ...form, promptCachePreference: value as PromptCachePreference })
            }
            ariaLabel={s.cachePreference}
            options={CACHE_OPTIONS.map(({ value, labelKey }) => ({
              value,
              label: String(s[labelKey as keyof typeof s]),
            }))}
          />
        </SettingsRow>
      )}

      <SettingToggle
        label={s.compaction}
        description={s.compactionHint}
        checked={form.providerCompactionEnabled ?? false}
        onChange={(providerCompactionEnabled) => onChange({ ...form, providerCompactionEnabled })}
      />
    </SettingsSection>
  );
}
