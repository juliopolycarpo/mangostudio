/**
 * A card displaying a single tool's settings.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { useI18n } from '@/hooks/use-i18n';
import { useUpdateToolSetting } from '../hooks/use-tool-settings';
import { ToolParameterField } from './ToolParameterField';
import { Card } from '@/components/ui/Card';

const TOOL_PARAMETERS_AUTOSAVE_MS = 300;

function areToolParametersEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [enabled, setEnabled] = useState(descriptor.enabled);
  const [params, setParams] = useState<Record<string, unknown>>({ ...descriptor.parameters });

  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    try {
      const nextDescriptor = await mutateAsync({
        toolName: descriptor.name,
        body: { enabled: newEnabled },
      });
      setEnabled(typeof nextDescriptor.enabled === 'boolean' ? nextDescriptor.enabled : newEnabled);
    } catch {
      setEnabled(descriptor.enabled);
    }
  }, [enabled, mutateAsync, descriptor.name, descriptor.enabled]);

  const handleParamChange = useCallback((name: string, value: unknown) => {
    setParams((prev) => ({ ...prev, [name]: value }));
  }, []);

  const persistParameters = useCallback(async () => {
    const requestedParams = params;

    try {
      const nextDescriptor = await mutateAsync({
        toolName: descriptor.name,
        body: { parameters: requestedParams },
      });
      const nextParameters =
        nextDescriptor.parameters && typeof nextDescriptor.parameters === 'object'
          ? { ...nextDescriptor.parameters }
          : requestedParams;
      setParams((currentParams) =>
        areToolParametersEqual(currentParams, requestedParams) ? nextParameters : currentParams
      );
    } catch {
      setParams((currentParams) =>
        areToolParametersEqual(currentParams, requestedParams)
          ? { ...descriptor.parameters }
          : currentParams
      );
    }
  }, [mutateAsync, descriptor.name, descriptor.parameters, params]);

  const hasParameters = descriptor.parameterDescriptors.length > 0;
  const hasUnsavedParams = useMemo(
    () => enabled && hasParameters && !areToolParametersEqual(params, descriptor.parameters),
    [descriptor.parameters, enabled, hasParameters, params]
  );

  useEffect(() => {
    if (!hasUnsavedParams || isPending) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      void persistParameters();
    }, TOOL_PARAMETERS_AUTOSAVE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [hasUnsavedParams, isPending, persistParameters]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (!hasUnsavedParams || isPending) return;
      void persistParameters();
    },
    [hasUnsavedParams, isPending, persistParameters]
  );

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

      {hasParameters && (
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
          {isPending && (
            <p className="text-xs text-on-surface-variant" role="status" aria-live="polite">
              {s.saving}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
