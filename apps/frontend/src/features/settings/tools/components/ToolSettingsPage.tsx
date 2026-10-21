/**
 * Tools settings page: global tool configuration grouped by category.
 */

import type { ToolSettingsCategory } from '@mangostudio/shared/tool-settings';
import { Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsLoadError, SettingsLoading } from '@/components/settings/SettingsStates';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@/hooks/use-global-settings';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';
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

  return (
    <SettingsPage title={s.title} description={s.description}>
      {isLoading ? (
        <SettingsLoading />
      ) : error ? (
        <SettingsLoadError message={s.loadError} onRetry={() => void refetch()} />
      ) : (
        <>
          <SettingsSection title={s.executionTitle}>
            <SettingsRow
              label={s.maxToolIterationsLabel}
              hint={s.maxToolIterationsDescription}
              htmlFor="tool-max-iterations"
            >
              <Input
                id="tool-max-iterations"
                type="number"
                min={MAX_TOOL_ITERATIONS_MIN}
                max={MAX_TOOL_ITERATIONS_MAX}
                step={1}
                value={maxToolIterations}
                onChange={(event) => setMaxToolIterations(Number(event.target.value))}
                onBlur={(event) => setMaxToolIterations(Number(event.target.value))}
                className="w-32 text-center"
              />
            </SettingsRow>
          </SettingsSection>

          {descriptors.length === 0 ? (
            <Card padded={false}>
              <EmptyState icon={<Wrench size={ICON_LG} />} title={s.noTools} />
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
