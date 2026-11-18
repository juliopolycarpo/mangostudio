import { TOOL_EXECUTION_TIMEOUT_PARAM } from '@mangostudio/shared/tool-settings';
import { useQuery } from '@tanstack/react-query';

import { toolSettingsListQueryOptions } from '@/features/settings/tools/queries';

/**
 * The time limit, in seconds, the tool settings currently give a built-in tool,
 * or `null` while it loads, when the tool has no limit setting, or when it is
 * not asked for.
 *
 * This is the setting as it stands now, not a record of what a past call ran
 * under (the lifecycle snapshot does not carry the budget), so callers ask for
 * it only for a call that is still running, where the two agree. The settings
 * list is shared with the settings page through one query key, so any number of
 * running cards cost one request, and none while `enabled` is false.
 *
 * // Usage: const limit = useConfiguredToolTimeoutSeconds('bash', status === 'running');
 */
export function useConfiguredToolTimeoutSeconds(toolName: string, enabled: boolean): number | null {
  const { data } = useQuery({ ...toolSettingsListQueryOptions(), enabled });
  const seconds = data?.tools.find((tool) => tool.name === toolName)?.parameters[
    TOOL_EXECUTION_TIMEOUT_PARAM
  ];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
