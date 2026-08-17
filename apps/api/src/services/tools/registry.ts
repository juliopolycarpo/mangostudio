/**
 * Provider-agnostic tool registry.
 * Tools self-register at import time via registerTool().
 */

import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { noteUncheckpointedSource } from '../../modules/file-checkpoints/application/note-uncheckpointed-source';
import {
  getSafeEffectiveToolSettings,
  getToolDefinitionsForTools,
  getToolDescriptorsForTools,
} from './settings-policy';
import type { EffectiveToolSettings, RegisteredTool, ToolContext, ToolDefinition } from './types';

export {
  getDefaultToolSettings,
  getSafeEffectiveToolSettings,
  mergeToolSettings,
  ToolParameterError,
} from './settings-policy';

const registry = new Map<string, RegisteredTool>();

/** Registers a tool. Called by each builtin at import time. */
export function registerTool(tool: RegisteredTool): void {
  registry.set(tool.definition.name, tool);
}

/** Returns the registered tool for the given name, or undefined if not found. */
export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

/** Returns all registered tools. */
export function getAllTools(): RegisteredTool[] {
  return Array.from(registry.values());
}

/** Returns only enabled JSON Schema definitions for provider requests. */
export function getAllToolDefinitions(
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings> = new Map()
): ToolDefinition[] {
  return getToolDefinitionsForSettings(settingsByToolName);
}

export function getToolDescriptors(
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings> = new Map()
): ToolSettingsDescriptor[] {
  return getToolDescriptorsForTools(getAllTools(), settingsByToolName);
}

export function getToolDefinitionsForSettings(
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings> = new Map()
): ToolDefinition[] {
  return getToolDefinitionsForTools(getAllTools(), settingsByToolName);
}

/**
 * Executes a registered tool by name.
 * Throws if the tool is not found.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
  settings?: EffectiveToolSettings,
  resolved?: { tool: RegisteredTool; effectiveSettings: EffectiveToolSettings }
): Promise<unknown> {
  const tool = resolved?.tool ?? getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: "${name}"`);
  }
  const effectiveSettings =
    resolved?.effectiveSettings ?? getSafeEffectiveToolSettings(tool, settings);
  if (!effectiveSettings.enabled) {
    throw new Error(`Tool "${name}" is disabled for this user.`);
  }
  // Before the call, not after: a tool that writes outside the manifest has
  // already done so by the time it reports either way. This is the one place
  // any builtin executor runs, so declaring `uncheckpointedWriteSource` is
  // enough to be covered — no dispatcher has to remember to record it.
  await noteUncheckpointedSource(context, tool.settings.uncheckpointedWriteSource);
  return tool.execute(args, {
    ...context,
    parameters: { ...effectiveSettings.parameters, ...context.parameters },
  });
}

/** Removes all registrations — for test isolation only. */
export function clearRegistry(): void {
  registry.clear();
}
