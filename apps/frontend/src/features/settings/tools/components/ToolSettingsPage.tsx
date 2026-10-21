/**
 * Tools settings page: global tool configuration grouped by category.
 */

import type { ToolSettingsCategory } from '@mangostudio/shared/tool-settings';
import { Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsSliderRow } from '@/components/settings/SettingsSliderRow';
import { SettingsLoadError, SettingsLoading } from '@/components/settings/SettingsStates';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@/hooks/use-global-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useToolSettings } from '../hooks/use-tool-settings';
import { ToolSettingsRow } from './ToolSettingsRow';

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

  return (
    <SettingsPage title={s.title} description={s.description}>
      {isLoading ? (
        <SettingsLoading />
      ) : error ? (
        <SettingsLoadError message={s.loadError} onRetry={() => void refetch()} />
      ) : (
        <>
          <SettingsSection title={s.executionTitle}>
            <SettingsSliderRow
              id="tool-max-iterations"
              label={s.maxToolIterationsLabel}
              hint={s.maxToolIterationsDescription}
              readout={hintText}
              value={maxToolIterations}
              min={MAX_TOOL_ITERATIONS_MIN}
              max={MAX_TOOL_ITERATIONS_MAX}
              onChange={setMaxToolIterations}
              withNumberInput
            />
          </SettingsSection>

          {descriptors.length === 0 ? (
            <Card padded={false}>
              <EmptyState icon={<Wrench size={24} />} title={s.noTools} />
            </Card>
          ) : (
            CATEGORIES.map((category) => {
              const tools = grouped[category];
              if (tools.length === 0) return null;
              return (
                <SettingsSection key={category} title={s.categories[category]}>
                  {tools.map((tool) => (
                    <ToolSettingsRow key={tool.name} descriptor={tool} />
                  ))}
                </SettingsSection>
              );
            })
          )}
        </>
      )}
    </SettingsPage>
  );
}
