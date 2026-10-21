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
import { SettingsSliderRow } from '@/components/settings/SettingsSliderRow';
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
  const { t } = useI18n();
  const s = t.settings.providers;

  return (
    <SettingsSection title={s.sectionTools}>
      {toolUseSupported && (
        // `commitOnBlur` is off: an unset value is shown as the default, and
        // tabbing through the number field must not pin it as an override.
        <SettingsSliderRow
          id="tool-iterations"
          label={s.maxToolIterations}
          readout={form.maxToolIterations ?? '—'}
          value={form.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT}
          min={MAX_TOOL_ITERATIONS_MIN}
          max={MAX_TOOL_ITERATIONS_MAX}
          onChange={(value) => onChange({ ...form, maxToolIterations: value })}
          withNumberInput
          commitOnBlur={false}
        />
      )}

      <SettingsRow label={s.maxOutputTokens} htmlFor="max-output-tokens" layout="field">
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
          placeholder={s.maxOutputTokensPlaceholder.replace(
            '{limit}',
            String(maxOutputTokensLimit)
          )}
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
