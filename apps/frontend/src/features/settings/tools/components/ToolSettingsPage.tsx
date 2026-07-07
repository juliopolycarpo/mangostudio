/**
 * Tools settings page: global tool configuration grouped by category.
 */

import type { ToolSettingsCategory } from '@mangostudio/shared/tool-settings';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@/hooks/use-global-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useToolSettings } from '../hooks/use-tool-settings';
import { ToolSettingsCard } from './ToolSettingsCard';

interface ToolSettingsPageProps {
  maxToolIterations: number;
  setMaxToolIterations: (value: number) => void;
}

const CATEGORIES: ToolSettingsCategory[] = ['system', 'image', 'interaction', 'mcp'];

export function ToolSettingsPage({
  maxToolIterations,
  setMaxToolIterations,
}: ToolSettingsPageProps) {
  const { t } = useI18n();
  const { descriptors, isLoading, error, refetch } = useToolSettings();
  const s = t.settings.tools;

  const grouped = useMemo(() => {
    const map: Record<ToolSettingsCategory, typeof descriptors> = {
      system: [],
      image: [],
      interaction: [],
      mcp: [],
    };
    for (const d of descriptors) {
      map[d.category]?.push(d);
    }
    return map;
  }, [descriptors]);

  const hintText = s.maxToolIterationsHint.replace('{value}', String(maxToolIterations));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{s.loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Execution section ── */}
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.executionTitle}
        </h3>
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4">
          <h4 className="text-sm text-on-surface font-medium">{s.maxToolIterationsLabel}</h4>
          <span className="text-sm font-medium text-on-surface">{hintText}</span>
        </div>
        <p className="text-sm text-on-surface-variant/60">{s.maxToolIterationsDescription}</p>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={MAX_TOOL_ITERATIONS_MIN}
            max={MAX_TOOL_ITERATIONS_MAX}
            step={1}
            value={maxToolIterations}
            onChange={(e) => setMaxToolIterations(Number(e.target.value))}
            aria-label={s.maxToolIterationsLabel}
            className="flex-1 h-2 bg-surface-container-lowest rounded-full appearance-none cursor-pointer accent-primary"
          />
          <input
            type="number"
            min={MAX_TOOL_ITERATIONS_MIN}
            max={MAX_TOOL_ITERATIONS_MAX}
            step={1}
            value={maxToolIterations}
            onChange={(e) => setMaxToolIterations(Number(e.target.value))}
            onBlur={(e) => setMaxToolIterations(Number(e.target.value))}
            aria-label={s.maxToolIterationsLabel}
            className="
              w-20 rounded-xl px-3 py-2 text-sm text-center
              bg-surface-container-lowest text-on-surface
              border border-outline-variant/20
              focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
              transition-colors
            "
          />
        </div>
      </Card>

      {/* ── Tool cards by category ── */}
      {descriptors.length === 0 ? (
        <p className="text-sm text-on-surface-variant/60 text-center py-8">{s.noTools}</p>
      ) : (
        CATEGORIES.map((category) => {
          const tools = grouped[category];
          if (tools.length === 0) return null;
          return (
            <section key={category} className="space-y-3">
              <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label px-1">
                {s.categories[category]}
              </h3>
              <div className="space-y-3">
                {tools.map((tool) => (
                  <ToolSettingsCard key={tool.name} descriptor={tool} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
