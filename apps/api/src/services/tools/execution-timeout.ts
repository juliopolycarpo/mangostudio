import type { EffectiveToolSettings, RegisteredTool } from './types';

/** Well-known tool-settings parameter for per-tool execution budgets. */
export const TOOL_EXECUTION_TIMEOUT_PARAM = 'timeoutSeconds';

export const TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT = 30;
export const TOOL_EXECUTION_TIMEOUT_SECONDS_MIN = 5;
export const TOOL_EXECUTION_TIMEOUT_SECONDS_MAX = 600;

const SHELL_TOOL_NAMES = new Set(['bash', 'zsh', 'powershell']);

export function toolSupportsExecutionTimeout(tool: RegisteredTool): boolean {
  return tool.settings.parameterDescriptors.some(
    (descriptor) => descriptor.name === TOOL_EXECUTION_TIMEOUT_PARAM
  );
}

/**
 * Maps legacy shell `timeoutMs` settings to `timeoutSeconds` before descriptor
 * normalization rejects the retired key.
 */
export function migrateLegacyToolParameters(
  toolName: string,
  parameters: Record<string, unknown>,
  savedParameters?: Record<string, unknown>,
  parameterUpdates?: Record<string, unknown>
): Record<string, unknown> {
  if (!SHELL_TOOL_NAMES.has(toolName)) return parameters;

  const hasExplicitTimeoutSeconds =
    savedParameters?.[TOOL_EXECUTION_TIMEOUT_PARAM] !== undefined ||
    parameterUpdates?.[TOOL_EXECUTION_TIMEOUT_PARAM] !== undefined;
  if (hasExplicitTimeoutSeconds) {
    const { timeoutMs: _legacy, ...rest } = parameters;
    return rest;
  }

  const legacyMs = parameters.timeoutMs;
  if (typeof legacyMs !== 'number' || !Number.isFinite(legacyMs)) {
    const { timeoutMs: _legacy, ...rest } = parameters;
    return rest;
  }
  const { timeoutMs: _legacy, ...rest } = parameters;
  return {
    ...rest,
    // Clamp into the current bounds: legacy `timeoutMs` allowed values as low as
    // 1s, which would round below the new 5s floor and make normalization throw,
    // resetting every other saved shell setting to defaults.
    [TOOL_EXECUTION_TIMEOUT_PARAM]: Math.min(
      TOOL_EXECUTION_TIMEOUT_SECONDS_MAX,
      Math.max(TOOL_EXECUTION_TIMEOUT_SECONDS_MIN, Math.round(legacyMs / 1000))
    ),
  };
}

/** Resolves the wall-clock budget for a builtin tool call in milliseconds. */
export function resolveEffectiveToolTimeoutMs(
  tool: RegisteredTool,
  settings: EffectiveToolSettings
): number {
  if (!toolSupportsExecutionTimeout(tool)) {
    return TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT * 1000;
  }

  const seconds = settings.parameters[TOOL_EXECUTION_TIMEOUT_PARAM];
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT * 1000;
  }
  return seconds * 1000;
}

export function buildToolExecutionTimeoutDescriptor(): {
  name: typeof TOOL_EXECUTION_TIMEOUT_PARAM;
  label: string;
  description: string;
  type: 'number';
  required: true;
  defaultValue: number;
  min: number;
  max: number;
} {
  return {
    name: TOOL_EXECUTION_TIMEOUT_PARAM,
    label: 'Timeout (seconds)',
    description: 'Maximum time this tool may run before execution is cancelled.',
    type: 'number',
    required: true,
    defaultValue: TOOL_EXECUTION_TIMEOUT_SECONDS_DEFAULT,
    min: TOOL_EXECUTION_TIMEOUT_SECONDS_MIN,
    max: TOOL_EXECUTION_TIMEOUT_SECONDS_MAX,
  };
}
