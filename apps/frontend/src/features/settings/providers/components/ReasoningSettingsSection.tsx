/**
 * Reasoning & Thinking section for provider settings.
 */

import type { ReasoningPolicy } from '@mangostudio/shared/provider-settings';
import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import type { ReasoningEffort } from '@mangostudio/shared';
import { Card } from '@/components/ui/Card';
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
    <Card variant="solid" className="space-y-4 p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
        {s.sectionReasoning}
      </h3>

      {/* Thinking toggle */}
      {policy.thinkingToggleSupported && (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="thinking-toggle" className="text-sm text-on-surface">
            {s.thinkingEnabled}
          </label>
          <input
            id="thinking-toggle"
            type="checkbox"
            checked={form.thinkingEnabled ?? false}
            onChange={(e) => onChange({ ...form, thinkingEnabled: e.target.checked })}
            className="h-4 w-4 rounded border-outline-variant/30 accent-primary"
          />
        </div>
      )}

      {/* Reasoning effort */}
      <div className="space-y-2">
        <label className="text-sm text-on-surface">{s.reasoningEffort}</label>
        <div className="flex flex-wrap gap-2">
          {EFFORT_DISPLAY_ORDER.filter((e) => supportedSet.has(e)).map((effort) => (
            <button
              key={effort}
              type="button"
              onClick={() => onChange({ ...form, reasoningEffort: effort })}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                (form.reasoningEffort ?? policy.defaultEffort) === effort
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
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
