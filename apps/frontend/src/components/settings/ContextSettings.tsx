import type { ModelOption } from '@mangostudio/shared';
import type {
  ContextCompactionBehavior,
  ContextSettings as ContextSettingsValue,
} from '@mangostudio/shared/chat';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';

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
    <div className="space-y-4">
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-on-surface">{s.title}</h2>
        <p className="text-sm text-on-surface-variant/70">{s.description}</p>
        <p className="text-sm text-on-surface-variant/60">{s.keepHistory}</p>
      </Card>

      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.behaviorLabel}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.behaviorDescription}</p>
        <select
          value={settings.compactionBehavior}
          onChange={(event) =>
            setCompactionBehavior(event.target.value as ContextCompactionBehavior)
          }
          aria-label={s.behaviorLabel}
          className="w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors cursor-pointer"
        >
          <option value="ask">{s.behaviorOptions.ask}</option>
          <option value="auto_compact_current_chat">{s.behaviorOptions.autoCompact}</option>
          <option value="continue_with_summary_new_chat">{s.behaviorOptions.newChat}</option>
          <option value="off">{s.behaviorOptions.off}</option>
        </select>
      </Card>

      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
              {s.providerCompactionLabel}
            </h3>
            <p className="text-sm text-on-surface-variant/60">{s.providerCompactionDescription}</p>
          </div>
          <input
            type="checkbox"
            checked={settings.providerCompactionEnabled}
            onChange={(event) => setProviderCompactionEnabled(event.target.checked)}
            aria-label={s.providerCompactionLabel}
            className="mt-1 h-4 w-4 rounded border-outline-variant/30 accent-primary"
          />
        </div>
      </Card>

      <Card variant="solid" className="space-y-5 p-4 sm:p-6">
        <ThresholdControl
          label={s.warningThresholdLabel}
          description={s.warningThresholdDescription}
          hint={formatThreshold(settings.warningThreshold, s.thresholdHint)}
          value={toPercentValue(settings.warningThreshold)}
          onChange={(value) => setWarningThreshold(value / 100)}
        />
        <ThresholdControl
          label={s.dangerThresholdLabel}
          description={s.dangerThresholdDescription}
          hint={formatThreshold(settings.dangerThreshold, s.thresholdHint)}
          value={toPercentValue(settings.dangerThreshold)}
          onChange={(value) => setDangerThreshold(value / 100)}
        />
        <ThresholdControl
          label={s.hardStopThresholdLabel}
          description={s.hardStopThresholdDescription}
          hint={formatThreshold(settings.hardStopThreshold, s.thresholdHint)}
          value={toPercentValue(settings.hardStopThreshold)}
          onChange={(value) => setHardStopThreshold(value / 100)}
        />
      </Card>

      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.summaryModelLabel}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.summaryModelDescription}</p>
        <select
          value={settings.preferredSummaryModel}
          onChange={(event) => setPreferredSummaryModel(event.target.value)}
          aria-label={s.summaryModelLabel}
          className="w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors cursor-pointer"
        >
          <option value="current_model">{s.summaryModelCurrent}</option>
          {missingModelOption.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName}
            </option>
          ))}
          {availableModels.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </Card>
    </div>
  );
}

function ThresholdControl({
  label,
  description,
  hint,
  value,
  onChange,
}: {
  label: string;
  description: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {label}
        </h3>
        <span className="text-sm font-medium text-on-surface">{hint}</span>
      </div>
      <p className="text-sm text-on-surface-variant/60">{description}</p>
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
          className="flex-1 h-2 bg-surface-container-lowest rounded-full appearance-none cursor-pointer accent-primary"
        />
        <input
          type="number"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          onBlur={(event) => onChange(Number(event.target.value))}
          aria-label={label}
          className="w-20 rounded-xl px-3 py-2 text-sm text-center bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors"
        />
      </div>
    </div>
  );
}
