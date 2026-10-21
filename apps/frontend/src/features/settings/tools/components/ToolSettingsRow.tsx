/**
 * One tool as a settings row: its name and what it lets the agent do, the
 * switch that turns it on, and the parameters it exposes underneath.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { ToggleSwitch } from '@/components/ui/Toggle';
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

interface ToolSettingsRowProps {
  descriptor: ToolSettingsDescriptor;
}

/** The built-in file tools whose name and description the locale files carry. */
const TOOL_TEXT_KEYS = {
  read_file: 'readFile',
  write_file: 'writeFile',
  edit_file: 'editFile',
  replace_range: 'replaceRange',
  apply_patch: 'applyPatch',
  create_file: 'createFile',
  delete_file: 'deleteFile',
  move_file: 'moveFile',
  list_directory: 'listDirectory',
  glob: 'glob',
  grep: 'grep',
} as const satisfies Record<string, keyof Messages['settings']['tools']['toolNames']>;

function getTranslatedToolText(
  descriptor: ToolSettingsDescriptor,
  t: ReturnType<typeof useI18n>['t']
) {
  const s = t.settings.tools;
  const key = Object.hasOwn(TOOL_TEXT_KEYS, descriptor.name)
    ? TOOL_TEXT_KEYS[descriptor.name as keyof typeof TOOL_TEXT_KEYS]
    : undefined;
  if (!key) return { title: descriptor.title, description: descriptor.description };
  return { title: s.toolNames[key], description: s.toolDescriptions[key] };
}

export function ToolSettingsRow({ descriptor }: ToolSettingsRowProps) {
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
    <div>
      <SettingsRow
        as={descriptor.canDisable ? 'label' : 'div'}
        label={translated.title}
        hint={translated.description}
      >
        {descriptor.canDisable ? (
          <ToggleSwitch
            checked={enabled}
            onChange={() => void handleToggle()}
            aria-label={translated.title}
          />
        ) : (
          <span className="block text-right text-xs text-fg-muted">{s.cannotDisable}</span>
        )}
      </SettingsRow>

      {hasParameters && (
        <div className="space-y-4 px-4 pb-4">
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
            <p className="text-xs text-fg-muted" role="status" aria-live="polite">
              {s.saving}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
