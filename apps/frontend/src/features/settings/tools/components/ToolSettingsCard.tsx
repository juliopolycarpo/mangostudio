/**
 * A card displaying a single tool's settings.
 */

import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { useI18n } from '@/hooks/use-i18n';
import { useUpdateToolSetting } from '../hooks/use-tool-settings';
import { ToolParameterField } from './ToolParameterField';

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
    case 'write_file':
      return {
        title: s.toolNames.writeFile,
        description: s.toolDescriptions.writeFile,
      };
    case 'edit_file':
      return {
        title: s.toolNames.editFile,
        description: s.toolDescriptions.editFile,
      };
    case 'replace_range':
      return {
        title: s.toolNames.replaceRange,
        description: s.toolDescriptions.replaceRange,
      };
    case 'apply_patch':
      return {
        title: s.toolNames.applyPatch,
        description: s.toolDescriptions.applyPatch,
      };
    case 'create_file':
      return {
        title: s.toolNames.createFile,
        description: s.toolDescriptions.createFile,
      };
    case 'delete_file':
      return {
        title: s.toolNames.deleteFile,
        description: s.toolDescriptions.deleteFile,
      };
    case 'move_file':
      return {
        title: s.toolNames.moveFile,
        description: s.toolDescriptions.moveFile,
      };
    case 'list_directory':
      return {
        title: s.toolNames.listDirectory,
        description: s.toolDescriptions.listDirectory,
      };
    case 'glob':
      return {
        title: s.toolNames.glob,
        description: s.toolDescriptions.glob,
      };
    case 'grep':
      return {
        title: s.toolNames.grep,
        description: s.toolDescriptions.grep,
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
  const isMountedRef = useRef(true);

  const [enabled, setEnabled] = useState(descriptor.enabled);
  const [params, setParams] = useState<Record<string, unknown>>({ ...descriptor.parameters });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Now that a write from another tab refetches this list, the descriptor can
  // change under a mounted card while `enabled`/`params` — local state — stay
  // put. Left alone, the next `hasUnsavedParams` comparison reads the remote
  // value as a local edit and autosaves the stale params straight back over it,
  // which the other tab then sees as *its* remote change: two tabs on this page
  // would trade writes forever. Adopt a remote change only where the user has
  // not edited, since state still matching the descriptor this card was last
  // showing has no local edit to lose.
  const shownDescriptorRef = useRef(descriptor);

  useEffect(() => {
    const shownDescriptor = shownDescriptorRef.current;
    if (shownDescriptor === descriptor) return;
    shownDescriptorRef.current = descriptor;

    if (shownDescriptor.enabled !== descriptor.enabled) {
      setEnabled((currentEnabled) =>
        currentEnabled === shownDescriptor.enabled ? descriptor.enabled : currentEnabled
      );
    }

    if (!areToolParametersEqual(shownDescriptor.parameters, descriptor.parameters)) {
      setParams((currentParams) =>
        areToolParametersEqual(currentParams, shownDescriptor.parameters)
          ? { ...descriptor.parameters }
          : currentParams
      );
    }
  }, [descriptor]);

  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    try {
      const nextDescriptor = await mutateAsync({
        toolName: descriptor.name,
        body: { enabled: newEnabled },
      });
      if (!isMountedRef.current) return;
      setEnabled(typeof nextDescriptor.enabled === 'boolean' ? nextDescriptor.enabled : newEnabled);
    } catch {
      if (!isMountedRef.current) return;
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
      if (!isMountedRef.current) return;
      setParams((currentParams) =>
        areToolParametersEqual(currentParams, requestedParams) ? nextParameters : currentParams
      );
    } catch {
      if (!isMountedRef.current) return;
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

  // Hold the latest flush inputs in a ref so the unmount effect can stay
  // subscribed to nothing ([] deps). Depending on persistParameters/params here
  // would re-run this cleanup on every keystroke and fire an immediate,
  // non-debounced save of the previous value, defeating the autosave debounce.
  const flushInputsRef = useRef({ hasUnsavedParams, isPending, persistParameters });
  flushInputsRef.current = { hasUnsavedParams, isPending, persistParameters };

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      const flushInputs = flushInputsRef.current;
      if (!flushInputs.hasUnsavedParams || flushInputs.isPending) return;
      void flushInputs.persistParameters();
    },
    []
  );

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
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
            <Checkbox checked={enabled} onChange={() => void handleToggle()} />
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
