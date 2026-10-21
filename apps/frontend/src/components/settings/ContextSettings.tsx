import type { ModelOption } from '@mangostudio/shared/catalog';
import type {
  ContextCompactionBehavior,
  ContextSettings as ContextSettingsValue,
} from '@mangostudio/shared/chat';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsSliderRow } from '@/components/settings/SettingsSliderRow';
import { SettingToggle } from '@/components/settings/SettingToggle';
import { Callout } from '@/components/ui/Callout';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { modelSelectOptions } from '@/lib/model-select-options';

interface ContextSettingsProps {
  settings: ContextSettingsValue;
  availableModels: ModelOption[];
  setCompactionBehavior: (value: ContextCompactionBehavior) => void;
  setWarningThreshold: (value: number) => void;
  setDangerThreshold: (value: number) => void;
  setHardStopThreshold: (value: number) => void;
  setPreferredSummaryModel: (value: string) => void;
  setProviderCompactionEnabled: (value: boolean) => void;
}

const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 99;

function formatThreshold(value: number, hint: string): string {
  return hint.replace('{value}', String(Math.round(value * 100)));
}

function toPercentValue(value: number): number {
  return Math.round(value * 100);
}

export function ContextSettings({
  settings,
  availableModels,
  setCompactionBehavior,
  setWarningThreshold,
  setDangerThreshold,
  setHardStopThreshold,
  setPreferredSummaryModel,
  setProviderCompactionEnabled,
}: ContextSettingsProps) {
  const { t } = useI18n();
  const s = t.settings.context;

  const missingModelOption =
    settings.preferredSummaryModel !== 'current_model' &&
    !availableModels.some((model) => model.modelId === settings.preferredSummaryModel)
      ? [{ modelId: settings.preferredSummaryModel, displayName: settings.preferredSummaryModel }]
      : [];

  return (
    <SettingsPage title={s.title} description={s.description}>
      <Callout tone="info">{s.keepHistory}</Callout>

      <SettingsSection>
        <SettingsRow label={s.behaviorLabel} hint={s.behaviorDescription} layout="field">
          <Select
            value={settings.compactionBehavior}
            onChange={(value) => setCompactionBehavior(value as ContextCompactionBehavior)}
            ariaLabel={s.behaviorLabel}
            options={[
              { value: 'ask', label: s.behaviorOptions.ask },
              { value: 'auto_compact_current_chat', label: s.behaviorOptions.autoCompact },
              { value: 'continue_with_summary_new_chat', label: s.behaviorOptions.newChat },
              { value: 'off', label: s.behaviorOptions.off },
            ]}
          />
        </SettingsRow>
        <SettingToggle
          label={s.providerCompactionLabel}
          description={s.providerCompactionDescription}
          checked={settings.providerCompactionEnabled}
          onChange={setProviderCompactionEnabled}
        />
        <SettingsRow label={s.summaryModelLabel} hint={s.summaryModelDescription} layout="field">
          <Select
            value={settings.preferredSummaryModel}
            onChange={setPreferredSummaryModel}
            ariaLabel={s.summaryModelLabel}
            options={modelSelectOptions(
              { value: 'current_model', label: s.summaryModelCurrent },
              missingModelOption,
              availableModels
            )}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsSliderRow
          id="context-warning-threshold"
          label={s.warningThresholdLabel}
          hint={s.warningThresholdDescription}
          readout={formatThreshold(settings.warningThreshold, s.thresholdHint)}
          value={toPercentValue(settings.warningThreshold)}
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          onChange={(value) => setWarningThreshold(value / 100)}
          withNumberInput
        />
        <SettingsSliderRow
          id="context-danger-threshold"
          label={s.dangerThresholdLabel}
          hint={s.dangerThresholdDescription}
          readout={formatThreshold(settings.dangerThreshold, s.thresholdHint)}
          value={toPercentValue(settings.dangerThreshold)}
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          onChange={(value) => setDangerThreshold(value / 100)}
          withNumberInput
        />
        <SettingsSliderRow
          id="context-hard-stop-threshold"
          label={s.hardStopThresholdLabel}
          hint={s.hardStopThresholdDescription}
          readout={formatThreshold(settings.hardStopThreshold, s.thresholdHint)}
          value={toPercentValue(settings.hardStopThreshold)}
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          onChange={(value) => setHardStopThreshold(value / 100)}
          withNumberInput
        />
      </SettingsSection>
    </SettingsPage>
  );
}
