/**
 * Tool configuration section for provider settings.
 */

import {
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
} from '@mangostudio/shared/app-settings';
import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';

interface ToolSettingsSectionProps {
  maxOutputTokensLimit: number;
  toolUseSupported: boolean;
  form: UpdateProviderRuntimeSettingsBody;
  onChange: (form: UpdateProviderRuntimeSettingsBody) => void;
}

export function ToolSettingsSection({
  maxOutputTokensLimit,
  toolUseSupported,
  form,
  onChange,
}: ToolSettingsSectionProps) {
  const { t, locale } = useI18n();
  const s = t.settings.providers;

  return (
    <SettingsSection title={s.sectionTools}>
      {toolUseSupported && (
        // A range of a thousand steps is not something a slider can set, so the
        // number field is the whole control. An unset value is shown as the
        // default and nothing here commits on blur: tabbing through the field
        // must not pin that default as an override.
        <SettingsRow label={s.maxToolIterations} htmlFor="tool-iterations">
          <Input
            id="tool-iterations"
            type="number"
            min={MAX_TOOL_ITERATIONS_MIN}
            max={MAX_TOOL_ITERATIONS_MAX}
            step={1}
            value={form.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT}
            onChange={(e) => onChange({ ...form, maxToolIterations: Number(e.target.value) })}
            className="w-32 text-center"
          />
        </SettingsRow>
      )}

      <SettingsRow
        label={s.maxOutputTokens}
        hint={s.maxOutputTokensHint.replace('{limit}', maxOutputTokensLimit.toLocaleString(locale))}
        htmlFor="max-output-tokens"
      >
        <Input
          id="max-output-tokens"
          type="number"
          min={1}
          max={maxOutputTokensLimit}
          step={1}
          value={form.maxOutputTokens ?? ''}
          onChange={(e) =>
            onChange({
              ...form,
              maxOutputTokens: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          placeholder={s.maxOutputTokensPlaceholder}
          className="w-32 text-center"
        />
      </SettingsRow>

      {toolUseSupported && (
        <SettingToggle
          label={s.parallelToolCalls}
          checked={form.parallelToolCallsEnabled ?? false}
          onChange={(parallelToolCallsEnabled) => onChange({ ...form, parallelToolCallsEnabled })}
        />
      )}
    </SettingsSection>
  );
}
