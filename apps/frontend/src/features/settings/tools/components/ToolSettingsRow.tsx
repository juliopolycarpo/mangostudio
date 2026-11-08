/**
 * One tool as a settings row: its name and what it lets the agent do, the
 * switch that turns it on, and the parameters it exposes underneath.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type {
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
} from '@mangostudio/shared/tool-settings';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SettingsRow } from '@/components/settings/SettingsRow';
import { ToggleSwitch } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';

import { useUpdateToolSetting } from '../hooks/use-tool-settings';
import { toolSettingsKeys } from '../queries';
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
  const queryClient = useQueryClient();
  const { mutateAsync, isPending: isMutationPending } = useUpdateToolSetting();
  const translated = getTranslatedToolText(descriptor, t);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const activeParameterSaveRef = useRef<Record<string, unknown> | null>(null);

  const [isParameterSavePending, setParameterSavePending] = useState(false);
  const isPending = isMutationPending || isParameterSavePending;
  const [enabled, setEnabled] = useState(descriptor.enabled);
  const [parameterState, setParameterState] = useState(() => ({
    value: descriptor.parameters,
    saved: descriptor.parameters,
  }));
  const params = parameterState.value;

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
  // not edited. An explicit return to the saved value while a request is
  // pending is still a local edit, even when the two objects have equal values.
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

    const request = activeParameterSaveRef.current;
    const saved = descriptor.parameters;
    setParameterState((current) => {
      if (areToolParametersEqual(current.saved, saved)) return current;
      const hasNewerEdit = request !== null && current.value !== request;
      const adopt =
        current.value === current.saved ||
        (!hasNewerEdit && areToolParametersEqual(current.value, saved));
      return { value: adopt ? saved : current.value, saved };
    });
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
    const saving = activeParameterSaveRef.current !== null;
    setParameterState((current) => {
      const next = { ...current.value, [name]: value };
      return {
        ...current,
        value: !saving && areToolParametersEqual(next, current.saved) ? current.saved : next,
      };
    });
  }, []);

  const persistParameters = useCallback(async () => {
    if (activeParameterSaveRef.current !== null) return;
    const requestedParams = params;
    activeParameterSaveRef.current = requestedParams;
    if (isMountedRef.current) setParameterSavePending(true);

    try {
      const nextDescriptor = await mutateAsync({
        toolName: descriptor.name,
        body: { parameters: requestedParams },
      });
      if (!isMountedRef.current) return;
      // The mutation updates the list before awaiting capability invalidation.
      // A later list update may have superseded its response in that interval.
      const saved =
        queryClient
          .getQueryData<ToolSettingsListResponse>(toolSettingsKeys.list())
          ?.tools.find((tool) => tool.name === descriptor.name)?.parameters ??
        nextDescriptor.parameters ??
        requestedParams;
      setParameterState((current) => ({
        value:
          current.value === requestedParams || areToolParametersEqual(current.value, saved)
            ? saved
            : current.value,
        saved,
      }));
    } catch {
      if (!isMountedRef.current) return;
      setParameterState((current) =>
        current.value === requestedParams || areToolParametersEqual(current.value, current.saved)
          ? { ...current, value: current.saved }
          : current
      );
    } finally {
      activeParameterSaveRef.current = null;
      if (isMountedRef.current) setParameterSavePending(false);
    }
  }, [mutateAsync, descriptor.name, params, queryClient]);

  const hasParameters = descriptor.parameterDescriptors.length > 0;
  const hasUnsavedParams = useMemo(
    () => enabled && hasParameters && !areToolParametersEqual(params, parameterState.saved),
    [enabled, hasParameters, parameterState.saved, params]
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
        label={<span className="font-semibold">{translated.title}</span>}
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
        // The rail says these belong to the tool above, and their names are a
        // step smaller than the tool's own.
        <div className="mx-4 mb-4 space-y-4 border-l border-stroke pl-4">
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
            <p
              className="text-xs text-fg-muted"
              // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
              role="status"
              aria-live="polite"
            >
              {s.saving}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
