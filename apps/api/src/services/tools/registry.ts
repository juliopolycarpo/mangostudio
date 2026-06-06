/**
 * Provider-agnostic tool registry.
 * Tools self-register at import time via registerTool().
 */

import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
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
  normalizeToolParameters,
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

export function getToolDefinitionsForAgent(
  profile: AgentProfile,
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings> = new Map()
): ToolDefinition[] {
  if (!profile.toolsEnabled) return [];

  const allowedToolNames = new Set(profile.toolNames);
  if (allowedToolNames.size === 0) return [];

  const tools = getAllTools().filter(
    (tool) => allowedToolNames.has('*') || allowedToolNames.has(tool.definition.name)
  );

  return getToolDefinitionsForTools(tools, settingsByToolName);
}

/**
 * Executes a registered tool by name.
 * Throws if the tool is not found.
 */
// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
  settings?: EffectiveToolSettings
): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: "${name}"`);
  }
  const effectiveSettings = getSafeEffectiveToolSettings(tool, settings);
  if (!effectiveSettings.enabled) {
    throw new Error(`Tool "${name}" is disabled for this user.`);
  }
  return tool.execute(args, {
    ...context,
    parameters: { ...effectiveSettings.parameters, ...context.parameters },
  });
}

/** Removes all registrations — for test isolation only. */
export function clearRegistry(): void {
  registry.clear();
}
