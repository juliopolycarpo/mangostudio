/**
 * Core types for the tool registry.
 */

import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import type { RuntimeCapabilityAllow } from '@mangostudio/shared/runtime-home';
import type { ToolRetrySafety } from '@mangostudio/shared/tool-executions';
import type {
  ToolParameterDescriptor,
  ToolSettingsCategory,
} from '@mangostudio/shared/tool-settings';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/types';
import type { ToolDefinition } from '../providers/types';

export type { ToolDefinition };

export interface DelegateToAgentInput {
  agentId: string;
  task: string;
  context?: string;
  expectedOutput?: string;
  maxTurns?: number;
}

export interface WorkdirPolicy {
  root: string;
  restricted: boolean;
}

/** Runtime context injected into every tool call. */
export interface ToolContext {
  userId: string;
  chatId: string;
  /**
   * Chat-owned runtime environment used for filesystem, shell, and checkpoint I/O.
   * Direct non-chat invocations omit it and use the Local runtime.
   */
  environmentId?: string;
  /** Assistant message id for the active turn; drives per-message file checkpoints. */
  assistantMessageId?: string;
  /** Optional DB handle for checkpoint persistence (generation passes the turn db). */
  db?: Kysely<Database>;
  /** Chat-bound server directory: defaults omitted tool paths and anchors relative ones. */
  workdir?: string;
  /** When set with `restricted: true`, builtin path tools must stay inside `root`. */
  workdirPolicy?: WorkdirPolicy;
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
  /**
   * Runtime consent features this tool needs. Absent means hub-only (no
   * runtime call). Capability resolution withholds the tool when the
   * connected machine's manifest denies any of these.
   */
  requiredCapabilities?: readonly (keyof RuntimeCapabilityAllow)[];
  /**
   * Set by tools that can write to the filesystem without producing a
   * checkpoint, naming the class the revert copy speaks about. Declared here
   * rather than matched on tool name so a shell added later is covered by
   * building it, not by remembering to extend a list.
   *
   * Absent means one of two things and the difference does not matter to
   * revert: the tool writes and checkpoints every path it touches, or it does
   * not write at all.
   */
  uncheckpointedWriteSource?: UncheckpointedWriteSource;
  /**
   * For a tool that can snapshot its own writes when asked to: returns true
   * when this call's parameters make it do so. The dispatcher then skips the
   * up-front `uncheckpointedWriteSource` note and the executor takes over,
   * noting the source only when its snapshot did not cover the call.
   */
  checkpointsOwnWrites?: (parameters: Record<string, unknown>) => boolean;
  /**
   * Whether running a call to this tool again is safe: `safe_read` changes
   * nothing, so a retry runs without asking; `confirmation_required` asks first;
   * `unknown` is a tool the hub cannot vouch for. Declared here, like
   * `uncheckpointedWriteSource`, so a tool is classified when it is built
   * instead of by a name list someone has to remember to extend.
   *
   * Absent means `confirmation_required`: the cautious answer is the default and
   * a read has to be claimed. Every builtin states its own, and a test fails for
   * one that does not. See `classifyToolRetrySafety`.
   */
  retrySafety?: ToolRetrySafety;
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
