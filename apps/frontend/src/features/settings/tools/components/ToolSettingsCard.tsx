/**
 * A card displaying a single tool's settings.
 */

import { useState, useCallback } from 'react';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useUpdateToolSetting } from '../hooks/use-tool-settings';
import { ToolParameterField } from './ToolParameterField';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

interface ToolSettingsCardProps {
  descriptor: ToolSettingsDescriptor;
}

function getTranslatedToolText(
  descriptor: ToolSettingsDescriptor,
  t: ReturnType<typeof useI18n>['t']
) {
  const s = t.settings.tools;
  switch (descriptor.name) {
    case 'read_file':
      return {
        title: s.toolNames.readFile,
        description: s.toolDescriptions.readFile,
      };
    case 'list_directory':
      return {
        title: s.toolNames.listDirectory,
        description: s.toolDescriptions.listDirectory,
      };
    default:
      return {
        title: descriptor.title,
        description: descriptor.description,
      };
  }
}

export function ToolSettingsCard({ descriptor }: ToolSettingsCardProps) {
  const { t } = useI18n();
  const s = t.settings.tools;
  const { mutateAsync, isPending } = useUpdateToolSetting();
  const translated = getTranslatedToolText(descriptor, t);

  const [enabled, setEnabled] = useState(descriptor.enabled);
  const [params, setParams] = useState<Record<string, unknown>>({ ...descriptor.parameters });

  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    try {
      await mutateAsync({ toolName: descriptor.name, body: { enabled: newEnabled } });
    } catch {
      setEnabled(descriptor.enabled);
    }
  }, [enabled, mutateAsync, descriptor.name, descriptor.enabled]);

  const handleParamChange = useCallback((name: string, value: unknown) => {
    setParams((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await mutateAsync({ toolName: descriptor.name, body: { parameters: params } });
    } catch {
      setParams({ ...descriptor.parameters });
    }
  }, [mutateAsync, descriptor.name, descriptor.parameters, params]);

  const hasParamChanges = descriptor.parameterDescriptors.length > 0;

  return (
    <Card variant="solid" className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <h4 className="text-sm font-bold text-on-surface">{translated.title}</h4>
          {translated.description && (
            <p className="text-xs text-on-surface-variant/70 leading-relaxed">
              {translated.description}
            </p>
          )}
        </div>
        {descriptor.canDisable ? (
          <label className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-on-surface-variant">
              {enabled ? s.enabled : s.disabled}
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={() => void handleToggle()}
              className="h-4 w-4 rounded border-outline-variant/30 accent-primary"
            />
          </label>
        ) : (
          <span className="text-xs text-on-surface-variant/50 italic shrink-0 text-right">
            {s.cannotDisable}
          </span>
        )}
      </div>

      {hasParamChanges && (
        <div className="space-y-3 pt-2 border-t border-outline-variant/10">
          {descriptor.parameterDescriptors.map((pd) => {
            const qualityDisabled =
              pd.name === 'defaultQuality' && params.letAiDecideQuality === true;
            return (
              <ToolParameterField
                key={pd.name}
                descriptor={pd}
                value={params[pd.name]}
                onChange={(v) => handleParamChange(pd.name, v)}
                disabled={!enabled || qualityDisabled}
              />
            );
          })}
          <Button
            variant="secondary"
            size="sm"
            loading={isPending}
            disabled={!enabled}
            onClick={() => void handleSave()}
          >
            {isPending ? s.saving : s.save}
          </Button>
        </div>
      )}
    </Card>
  );
}
