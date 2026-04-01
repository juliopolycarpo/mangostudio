/**
 * Provider-agnostic tool registry.
 * Tools self-register at import time via registerTool().
 */

import type { RegisteredTool, ToolContext, ToolDefinition } from './types';

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

/** Returns only the JSON Schema definitions (used when building provider requests). */
export function getAllToolDefinitions(): ToolDefinition[] {
  return getAllTools().map((t) => t.definition);
}

/**
 * Executes a registered tool by name.
 * Throws if the tool is not found.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: "${name}"`);
  }
  return tool.execute(args, context);
}

/** Removes all registrations — for test isolation only. */
export function clearRegistry(): void {
  registry.clear();
}
