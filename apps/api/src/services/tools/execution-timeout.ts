import { TOOL_EXECUTION_TIMEOUT_PARAM } from '@mangostudio/shared/tool-settings';

import type { EffectiveToolSettings, RegisteredTool } from './types';

/**
 * A tool call exceeded its execution budget. Thrown by both the shared timeout
 * wrapper and tools that manage their own timeout (shells), so the lifecycle
 * owner can classify the outcome as `timed_out` without matching message text.
 */
export class ToolExecutionTimedOutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolExecutionTimedOutError';
  }
}

// Re-exported so the API's tools and tests keep one import site; the name is
// shared with the chat card that displays the budget.
export { TOOL_EXECUTION_TIMEOUT_PARAM };

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

/** A running deadline for one tool call; see {@link startToolTimeout}. */
export interface ToolTimeoutGuard {
  /**
   * Aborts when the parent aborts or the deadline passes. Hand this, not the
   * parent signal, to whatever does the work, so the work itself is cancelled.
   */
  readonly signal: AbortSignal;
  /** True only when the deadline fired; a parent abort never sets it. */
  readonly timedOut: boolean;
  /** Clears the timer and the parent listener. Safe to call more than once. */
  dispose(): void;
}

/**
 * Arms a wall-clock deadline for a tool call that does its own work in-process
 * (no shared wrapper around it). The returned signal aborts with a
 * {@link ToolExecutionTimedOutError} reason at the deadline, or with the
 * parent's reason if the parent aborts first, so a user Stop is never recorded
 * as a timeout.
 *
 * // Usage: const guard = startToolTimeout(turnSignal, 'generate_image', 30_000);
 */
export function startToolTimeout(
  parent: AbortSignal | undefined,
  name: string,
  timeoutMs: number
): ToolTimeoutGuard {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => controller.abort(parent?.reason);
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    parent?.removeEventListener('abort', onParentAbort);
  };

  if (parent?.aborted) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new ToolExecutionTimedOutError(`Tool "${name}" timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose,
  };
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
