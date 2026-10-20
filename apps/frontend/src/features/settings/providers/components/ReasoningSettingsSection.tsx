/**
 * Reasoning & Thinking section for provider settings.
 */

import type {
  ReasoningPolicy,
  UpdateProviderRuntimeSettingsBody,
} from '@mangostudio/shared/provider-settings';
import type { ReasoningEffort } from '@mangostudio/shared/types';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
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

  const supportedSet = new Set<ReasoningEffort>(policy.supportedEfforts);

  return (
    <Card className="space-y-4 p-4 sm:p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-fg-muted">
        {s.sectionReasoning}
      </h3>

      {/* Thinking toggle */}
      {policy.thinkingToggleSupported && (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="thinking-toggle" className="text-sm text-fg">
            {s.thinkingEnabled}
          </label>
          <Checkbox
            id="thinking-toggle"
            checked={form.thinkingEnabled ?? false}
            onChange={(e) => onChange({ ...form, thinkingEnabled: e.target.checked })}
          />
        </div>
      )}

      {/* Reasoning effort */}
      <div className="space-y-2">
        <span className="text-sm text-fg">{s.reasoningEffort}</span>
        <div className="flex flex-wrap gap-2">
          {EFFORT_DISPLAY_ORDER.filter((e) => supportedSet.has(e)).map((effort) => (
            <button
              key={effort}
              type="button"
              onClick={() => onChange({ ...form, reasoningEffort: effort })}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                (form.reasoningEffort ?? policy.defaultEffort) === effort
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface text-fg-muted hover:bg-fill-hover'
              }`}
            >
              {t.thinking[EFFORT_LABEL_KEYS[effort] as keyof typeof t.thinking]}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
