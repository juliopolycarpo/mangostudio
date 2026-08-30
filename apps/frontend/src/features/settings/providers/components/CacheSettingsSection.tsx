/**
 * Prompt caching and provider compaction section.
 */

import type {
  PromptCachePreference,
  UpdateProviderRuntimeSettingsBody,
} from '@mangostudio/shared/provider-settings';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
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

type FormKey = keyof UpdateProviderRuntimeSettingsBody;

export function CacheSettingsSection({
  cachingSupported,
  form,
  onChange,
}: CacheSettingsSectionProps) {
  const { t } = useI18n();
  const s = t.settings.providers;

  const update = (key: FormKey, value: unknown) => {
    onChange({ ...form, [key]: value });
  };

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
        {s.sectionCache}
      </h3>

      {cachingSupported && (
        <div className="space-y-2">
          <label htmlFor="cache-preference" className="text-sm text-on-surface">
            {s.cachePreference}
          </label>
          <Select
            id="cache-preference"
            value={form.promptCachePreference ?? 'auto'}
            onChange={(value) => update('promptCachePreference', value)}
            options={CACHE_OPTIONS.map(({ value, labelKey }) => ({
              value,
              label: String(s[labelKey as keyof typeof s]),
            }))}
          />
        </div>
      )}

      {/* Provider-side compaction */}
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="compaction-toggle" className="text-sm text-on-surface">
          {s.compaction}
        </label>
        <Checkbox
          id="compaction-toggle"
          checked={form.providerCompactionEnabled ?? false}
          onChange={(e) => update('providerCompactionEnabled', e.target.checked)}
        />
      </div>
    </Card>
  );
}
