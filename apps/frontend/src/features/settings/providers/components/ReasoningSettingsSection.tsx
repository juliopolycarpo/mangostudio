/**
 * Reasoning & Thinking section for provider settings.
 */

import type {
  ReasoningPolicy,
  UpdateProviderRuntimeSettingsBody,
} from '@mangostudio/shared/provider-settings';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { useI18n } from '@/hooks/use-i18n';
import { EFFORT_DISPLAY_ORDER, EFFORT_LABEL_KEYS } from '../constants';

interface ReasoningSettingsSectionProps {
  policy: ReasoningPolicy;
  form: UpdateProviderRuntimeSettingsBody;
  onChange: (form: UpdateProviderRuntimeSettingsBody) => void;
}

export function ReasoningSettingsSection({
  policy,
  form,
  onChange,
}: ReasoningSettingsSectionProps) {
  const { t } = useI18n();
  const s = t.settings.providers;

  const efforts = EFFORT_DISPLAY_ORDER.filter((effort) =>
    policy.supportedEfforts.includes(effort)
  ).map((effort) => ({
    value: effort,
    label: t.thinking[EFFORT_LABEL_KEYS[effort] as keyof typeof t.thinking],
  }));

  return (
    <SettingsSection title={s.sectionReasoning}>
      {policy.thinkingToggleSupported && (
        <SettingToggle
          label={s.thinkingEnabled}
          description={s.thinkingEnabledHint}
          checked={form.thinkingEnabled ?? false}
          onChange={(thinkingEnabled) => onChange({ ...form, thinkingEnabled })}
        />
      )}

      <SettingsRow label={s.reasoningEffort} hint={s.reasoningEffortHint} layout="stacked">
        <SettingsSegmented
          ariaLabel={s.reasoningEffort}
          value={form.reasoningEffort ?? policy.defaultEffort}
          options={efforts}
          onChange={(reasoningEffort) => onChange({ ...form, reasoningEffort })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
