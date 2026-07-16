/**
 * Core types for the tool registry.
 */

import type {
  ToolParameterDescriptor,
  ToolSettingsCategory,
} from '@mangostudio/shared/tool-settings';
import type { ToolDefinition } from '../providers/types';

export type { ToolDefinition };

export interface DelegateToAgentInput {
  agentId: string;
  task: string;
  context?: string;
  expectedOutput?: string;
  maxTurns?: number;
}

/** Runtime context injected into every tool call. */
export interface ToolContext {
  userId: string;
  chatId: string;
  parameters: Record<string, unknown>;
  /** When aborted, long-running tools should stop work and release resources. */
  signal?: AbortSignal;
  delegateToAgent?: (input: DelegateToAgentInput) => Promise<unknown>;
}

/** Function signature for tool implementations. */
export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<unknown>;

interface ToolSettingsMetadata {
  title: string;
  description: string;
  category: ToolSettingsCategory;
  enabledByDefault: boolean;
  canDisable: boolean;
  defaultParameters: Record<string, unknown>;
  parameterDescriptors: ReadonlyArray<ToolParameterDescriptor>;
  /**
   * When true, the tool enforces its own execution timeout and the generic
   * wrapper should not add a second, racing timeout layer.
   */
  managesOwnTimeout?: boolean;
}

/** A fully registered tool: its schema definition + its executor. */
export interface RegisteredTool {
  definition: ToolDefinition;
  buildDefinition?: (settings: EffectiveToolSettings) => ToolDefinition;
  settings: ToolSettingsMetadata;
  execute: ToolExecutor;
}

export interface EffectiveToolSettings {
  enabled: boolean;
  parameters: Record<string, unknown>;
}
