/**
 * Tool configuration section for provider settings.
 */

import {
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
} from '@mangostudio/shared/app-settings';
import type { UpdateProviderRuntimeSettingsBody } from '@mangostudio/shared/provider-settings';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
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
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
        {s.sectionTools}
      </h3>

      {/* Max tool iterations */}
      {toolUseSupported && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="tool-iterations" className="text-sm text-on-surface">
              {s.maxToolIterations}
            </label>
            <span className="text-xs text-on-surface-variant">{form.maxToolIterations ?? '—'}</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="tool-iterations"
              type="range"
              min={MAX_TOOL_ITERATIONS_MIN}
              max={MAX_TOOL_ITERATIONS_MAX}
              step={1}
              value={form.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT}
              onChange={(e) => onChange({ ...form, maxToolIterations: Number(e.target.value) })}
              className="range-input flex-1"
            />
            <input
              type="number"
              min={MAX_TOOL_ITERATIONS_MIN}
              max={MAX_TOOL_ITERATIONS_MAX}
              step={1}
              value={form.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT}
              onChange={(e) => onChange({ ...form, maxToolIterations: Number(e.target.value) })}
              aria-label={s.maxToolIterations}
              className="w-24 rounded-xl px-3 py-2 text-sm text-center bg-surface-container-lowest text-on-surface border border-outline-variant/20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors"
            />
          </div>
        </div>
      )}

      {/* Max output tokens */}
      <div className="space-y-1.5">
        <label htmlFor="max-output-tokens" className="text-sm text-on-surface">
          {s.maxOutputTokens}
        </label>
        <input
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
          className="w-full rounded-xl px-4 py-2.5 text-sm bg-surface-container-high text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors"
        />
      </div>

      {/* Parallel tool calls */}
      {toolUseSupported && (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="parallel-tool-calls" className="text-sm text-on-surface">
            {s.parallelToolCalls}
          </label>
          <Checkbox
            id="parallel-tool-calls"
            checked={form.parallelToolCallsEnabled ?? false}
            onChange={(e) => onChange({ ...form, parallelToolCallsEnabled: e.target.checked })}
          />
        </div>
      )}
    </Card>
  );
}
