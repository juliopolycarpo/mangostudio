/**
 * Core types for the tool registry.
 */

import type { ToolDefinition } from '../providers/types';

export type { ToolDefinition };

/** Runtime context injected into every tool call. */
export interface ToolContext {
  userId: string;
  chatId: string;
}

/** Function signature for tool implementations. */
export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<unknown>;

/** A fully registered tool: its schema definition + its executor. */
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}
