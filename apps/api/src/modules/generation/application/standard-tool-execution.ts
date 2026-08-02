import type {
  McpElicitationPart,
  McpMediaPart,
  MessagePart,
  QuestionPart,
  TodoPart,
} from '@mangostudio/shared';
import type { AgentProfile } from '@mangostudio/shared/agents';
import { isAgentId } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { SUBAGENT_MAX_TURNS_MAX, SUBAGENT_MAX_TURNS_MIN } from '@mangostudio/shared/app-settings';
import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { classifyMcpCallFailure } from '../../../services/mcp/call-failure';
import {
  bindElicitationSink,
  cancelPendingElicitations,
  type McpElicitationCancelReason,
  type McpElicitationStatusEvent,
  releaseElicitationSink,
} from '../../../services/mcp/elicitation-registry';
import { persistMcpMediaParts } from '../../../services/mcp/rich-content';
import {
  executeResolvedMcpTool,
  type ResolvedMcpToolExecution,
  resolveMcpToolExecution,
} from '../../../services/mcp/tool-bridge';
import { isMcpToolName } from '../../../services/mcp/tool-naming';
import { executeTool, getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import {
  getBoundedOptionalInteger,
  getOptionalString,
  getRequiredString,
} from '../../../services/tools/arg-parsing';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseAskUserQuestionArgs,
} from '../../../services/tools/builtin/ask-user-question';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import { TODO_WRITE_TOOL_NAME, type TodoToolResult } from '../../../services/tools/builtin/todo';
import {
  resolveEffectiveToolTimeoutMs,
  ToolExecutionTimedOutError,
} from '../../../services/tools/execution-timeout';
import type {
  EffectiveToolSettings,
  RegisteredTool,
  WorkdirPolicy,
} from '../../../services/tools/types';
import { shouldExposeDelegateTool } from './delegate-tool-availability';
import { ensureDelegationResult, isSubagentRunResult, logDelegationWarn } from './delegation-retry';
import {
  getSubagentCachedEntry,
  recordSubagentResult,
  recordSubagentStatus,
  recordSubagentText,
} from './subagent-response-cache';
import {
  type DelegateToSubagentRequest,
  runSubagentTurn,
  SubagentDelegationError,
  type SubagentProgressEvent,
  type SubagentRunResult,
} from './subagent-runner';
import {
  isAbortError,
  subagentStatusToTerminal,
  ToolExecutionLifecycle,
  type ToolExecutionTransitionEvent,
  ToolPolicyError,
} from './tool-execution-lifecycle';
import { errorToToolMessage, parseToolArgs, stringifyToolResult } from './tool-result-utils';

interface StandardToolExecution {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  resultStr: string;
  isError: boolean;
  /** Terminal lifecycle snapshot the execution owner recorded for this call. */
  execution: ToolExecutionSnapshot;
  subagentTrace?: Extract<MessagePart, { type: 'subagent_trace' }>;
  /** Persisted rich media (images, files) an MCP tool call produced. */
  mcpMedia?: McpMediaPart[];
  /** Mid-call MCP form elicitations presented while the tool was awaited. */
  mcpElicitations?: McpElicitationPart[];
  /** Questions an ask_user_question call presented, rendered as a chat card. */
  questionPart?: QuestionPart;
  /** Snapshot of the list a todo_write call produced, rendered as a checklist. */
  todoPart?: TodoPart;
}

interface ShapedToolExecutionResult {
  providerResult: unknown;
  resultStr: string;
  questionPart?: QuestionPart;
  todoPart?: TodoPart;
}

export interface DelegationRuntime {
  db: Kysely<Database>;
  userId: string;
  chatId: string;
  environmentId: string;
  /** Delegating turn's assistant message; subagent mutations share its checkpoint. */
  assistantMessageId?: string;
  parentAgentProfile: AgentProfile;
  parentModelName: string;
  interactionMode: 'chat' | 'agent';
  workdir?: string;
  workdirPolicy?: WorkdirPolicy;
  settings: MultiAgentSettings;
  signal?: AbortSignal;
  state: { subagentCallCount: number };
  onEvent?: (event: ToolStreamEvent) => void;
}

/**
 * The subset of stream events emitted by the tool-execution layer: generic
 * system notices plus subagent delegation progress. The full streamTextTurn
 * union is a superset, so these flow through unchanged.
 */
export type ToolStreamEvent =
  | { type: 'system_event'; event: string; detail: string }
  | ToolExecutionTransitionEvent
  | { type: 'mcp_elicitation'; part: McpElicitationPart }
  | ({ type: 'mcp_elicitation_status' } & McpElicitationStatusEvent)
  | { type: 'subagent_started'; callId: string; agentId: string; agentName: string; task: string }
  | { type: 'subagent_text'; callId: string; agentId: string; text: string }
  | {
      type: 'subagent_tool_call_started';
      callId: string;
      agentId: string;
      toolCallId: string;
      name: string;
    }
  | {
      type: 'subagent_completed';
      callId: string;
      agentId: string;
      agentName: string;
      summary: string;
      toolCallCount: number;
    }
  | { type: 'subagent_failed'; callId: string; agentId: string; agentName?: string; error: string };

export type ToolExecutionProgressItem =
  | { kind: 'event'; event: ToolStreamEvent }
  | { kind: 'execution'; execution: StandardToolExecution };

export interface StandardToolExecutionContext {
  userId: string;
  chatId: string;
  environmentId: string;
  assistantMessageId?: string;
  workdir?: string;
  workdirPolicy?: WorkdirPolicy;
  settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
  allowedToolNames: ReadonlySet<string>;
  delegationRuntime?: DelegationRuntime;
  /** Required to route `mcp__` tool calls to their owning server. */
  db?: Kysely<Database>;
  signal?: AbortSignal;
  /** Mid-flight progress (subagent + MCP elicitation) into the SSE turn. */
  onEvent?: (event: ToolStreamEvent) => void;
}

type PreparedStandardToolCall =
  | {
      kind: 'mcp';
      db: Kysely<Database>;
      target: ResolvedMcpToolExecution;
    }
  | {
      kind: 'delegation';
      runtime: DelegationRuntime;
    }
  | {
      kind: 'builtin';
      tool: RegisteredTool;
      effectiveSettings: EffectiveToolSettings;
    };

export async function* executeStandardToolCallsWithProgress(
  calls: ReadonlyArray<[string, { name: string; argsStr: string }]>,
  context: StandardToolExecutionContext
): AsyncGenerator<ToolExecutionProgressItem> {
  // No calls means no completion callbacks ever fire, so the queue would never
  // close and `yield* queue` would hang. Exit before arming the queue.
  if (calls.length === 0) return;

  const queue = createAsyncQueue<ToolExecutionProgressItem>();
  let remaining = calls.length;

  for (const [callId, call] of calls) {
    const onEvent = (event: ToolStreamEvent) => queue.push({ kind: 'event', event });
    const runtime = context.delegationRuntime
      ? {
          ...context.delegationRuntime,
          onEvent,
        }
      : undefined;
    // The lifecycle is announced as queued before the call is scheduled, so
    // consumers see every call enter the pipeline even when it never starts.
    const lifecycle = new ToolExecutionLifecycle(callId, call.name, onEvent);
    lifecycle.emitQueued();
    void executeStandardToolCall(callId, call.name, call.argsStr, lifecycle, {
      ...context,
      onEvent,
      delegationRuntime: runtime,
    })
      .then((execution) => queue.push({ kind: 'execution', execution }))
      .catch((error: unknown) =>
        queue.push({
          kind: 'execution',
          execution: createFailedToolExecution(callId, call.name, call.argsStr, lifecycle, error),
        })
      )
      .finally(() => {
        remaining -= 1;
        if (remaining === 0) queue.close();
      });
  }

  yield* queue;
}

async function executeStandardToolCall(
  callId: string,
  name: string,
  argsStr: string,
  lifecycle: ToolExecutionLifecycle,
  context: StandardToolExecutionContext
): Promise<StandardToolExecution> {
  const args = parseToolArgs(argsStr);
  let result: unknown;
  let isError = false;
  let didThrow = false;
  let thrownError: unknown;
  let shapedResult: ShapedToolExecutionResult;
  let subagentTrace: Extract<MessagePart, { type: 'subagent_trace' }> | undefined;
  let mcpMedia: McpMediaPart[] | undefined;
  let mcpElicitations: McpElicitationPart[] | undefined;
  const isDelegationTool =
    name === DELEGATE_TO_AGENT_TOOL_NAME && Boolean(context.delegationRuntime);

  try {
    const prepared = await prepareStandardToolCall(name, context);
    lifecycle.transition('running');
    if (prepared.kind === 'mcp') {
      const mcpResult = await executeMcpToolCall(callId, args, lifecycle, context, prepared);
      result = mcpResult.result;
      isError = mcpResult.isError;
      mcpMedia = mcpResult.mediaParts;
      mcpElicitations = mcpResult.elicitationParts;
    } else if (prepared.kind === 'delegation') {
      const request = parseDelegationRequest(args);
      // Retry/cache-recovery wraps each single-attempt delegation; the per-call
      // runtime carries the abort signal, timeout, and the onEvent sink that
      // streams subagent progress back to the caller.
      result = await ensureDelegationResult(callId, request, {
        signal: prepared.runtime.signal,
        timeoutMs: prepared.runtime.settings.timeoutMs,
        onEvent: prepared.runtime.onEvent,
        executeDelegation: (delegationCallId, delegationRequest) =>
          executeDelegationToolCall(delegationCallId, delegationRequest, prepared.runtime),
      });
    } else {
      const timeoutMs = resolveEffectiveToolTimeoutMs(prepared.tool, prepared.effectiveSettings);
      const timeoutController = new AbortController();
      const parentSignal = context.signal;
      const onParentAbort = () => timeoutController.abort(parentSignal?.reason);
      if (parentSignal) {
        if (parentSignal.aborted) timeoutController.abort(parentSignal.reason);
        else parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }

      try {
        const toolPromise = executeTool(
          name,
          args,
          {
            userId: context.userId,
            chatId: context.chatId,
            environmentId: context.environmentId,
            assistantMessageId: context.assistantMessageId,
            db: context.db,
            workdir: context.workdir,
            workdirPolicy: context.workdirPolicy,
            parameters: {},
            signal: timeoutController.signal,
          },
          prepared.effectiveSettings,
          prepared
        );

        // Tools that enforce their own timeout (e.g. shells) are not wrapped,
        // because a second, equally-long timer can win the race and reject
        // before the tool has finished killing and reaping its child process.
        result = prepared.tool.settings.managesOwnTimeout
          ? await toolPromise
          : await withToolTimeout(toolPromise, name, timeoutMs, timeoutController);
      } finally {
        parentSignal?.removeEventListener('abort', onParentAbort);
      }
    }
    if (isSubagentRunResult(result)) {
      subagentTrace = createSubagentTraceForTool(callId, result);
      isError = result.status !== 'completed';
    }
    // Result shaping is deliberately part of the fallible execution region.
    // A malformed successful result must fail before the terminal snapshot is
    // chosen, otherwise persisted lifecycle state can disagree with isError.
    shapedResult = shapeToolExecutionResult(callId, name, args, result, isError);
  } catch (error) {
    result = { error: errorToToolMessage(error) };
    shapedResult = {
      providerResult: result,
      resultStr: stringifyToolResult(result),
    };
    isError = true;
    didThrow = true;
    thrownError = error;
  }

  // Exactly one terminal transition, applied after every fallible execution
  // and shaping step but before the result is surfaced.
  if (didThrow) {
    lifecycle.fail(thrownError, context.signal);
  } else if (isSubagentRunResult(result)) {
    const terminal = subagentStatusToTerminal(result.status);
    lifecycle.transition(terminal.status, terminal.reasonCode);
  } else {
    lifecycle.transition(isError ? 'failed' : 'succeeded', isError ? 'execution_error' : undefined);
  }

  if (isDelegationTool) {
    const entry = getSubagentCachedEntry(callId);
    const summaryLength =
      (isSubagentRunResult(result) ? result.summary.length : entry?.result?.summary.length) ?? 0;
    logDelegationWarn('tool_result_ready', {
      callId,
      agentId: isSubagentRunResult(result) ? result.agentId : (entry?.agentId ?? ''),
      isError,
      summaryLength,
      cachedPartialChars: entry?.partialText?.length ?? 0,
    });
  }
  return {
    callId,
    name,
    args,
    result: shapedResult.providerResult,
    resultStr: shapedResult.resultStr,
    isError,
    execution: lifecycle.current,
    ...(subagentTrace ? { subagentTrace } : {}),
    ...(mcpMedia?.length ? { mcpMedia } : {}),
    ...(mcpElicitations?.length ? { mcpElicitations } : {}),
    ...(shapedResult.questionPart ? { questionPart: shapedResult.questionPart } : {}),
    ...(shapedResult.todoPart ? { todoPart: shapedResult.todoPart } : {}),
  };
}

function shapeToolExecutionResult(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  isError: boolean
): ShapedToolExecutionResult {
  const providerResult = isSubagentRunResult(result) ? createSubagentToolResult(result) : result;
  const questionPart =
    name === ASK_USER_QUESTION_TOOL_NAME && !isError ? createQuestionPart(callId, args) : undefined;
  const todoPart =
    name === TODO_WRITE_TOOL_NAME && !isError ? createTodoPart(callId, result) : undefined;

  return {
    providerResult,
    resultStr: stringifyToolResult(providerResult),
    ...(questionPart ? { questionPart } : {}),
    ...(todoPart ? { todoPart } : {}),
  };
}

/** Resolves every policy decision before a call is marked as running. */
async function prepareStandardToolCall(
  name: string,
  context: StandardToolExecutionContext
): Promise<PreparedStandardToolCall> {
  if (!context.allowedToolNames.has(name)) {
    throw new ToolPolicyError(`Tool "${name}" is not allowed for this agent.`, 'not_allowed');
  }

  if (isMcpToolName(name)) {
    if (!context.db) {
      throw new ToolPolicyError(`Tool "${name}" is not available in this context.`, 'not_allowed');
    }
    if (context.settingsByToolName.get(name)?.enabled === false) {
      throw new ToolPolicyError(`Tool "${name}" is disabled for this user.`, 'tool_disabled');
    }
    try {
      return {
        kind: 'mcp',
        db: context.db,
        target: await resolveMcpToolExecution(
          context.db,
          context.userId,
          name,
          context.environmentId
        ),
      };
    } catch (error) {
      throw new ToolPolicyError(errorToToolMessage(error), 'unknown_tool');
    }
  }

  const tool = getTool(name);
  if (!tool) throw new ToolPolicyError(`Unknown tool: "${name}"`, 'unknown_tool');
  const effectiveSettings = getSafeEffectiveToolSettings(
    tool,
    context.settingsByToolName.get(name)
  );
  if (!effectiveSettings.enabled) {
    throw new ToolPolicyError(`Tool "${name}" is disabled for this user.`, 'tool_disabled');
  }

  const runtime = context.delegationRuntime;
  if (name === DELEGATE_TO_AGENT_TOOL_NAME && runtime) {
    return { kind: 'delegation', runtime };
  }
  return { kind: 'builtin', tool, effectiveSettings };
}

/**
 * Routes a namespaced `mcp__<slug>__<tool>` call to the bridge. The per-call
 * timeout comes from the server row (SDK-enforced, so a timed-out request is
 * actually cancelled); a user-disabled tool is rejected before any connect.
 * Rich content blocks of a successful call are persisted as media parts.
 */
async function executeMcpToolCall(
  callId: string,
  args: Record<string, unknown>,
  lifecycle: ToolExecutionLifecycle,
  context: StandardToolExecutionContext,
  prepared: Extract<PreparedStandardToolCall, { kind: 'mcp' }>
): Promise<{
  result: unknown;
  isError: boolean;
  mediaParts?: McpMediaPart[];
  elicitationParts?: McpElicitationPart[];
}> {
  const elicitationParts: McpElicitationPart[] = [];
  bindElicitationSink(
    context.userId,
    prepared.target.server.id,
    callId,
    (part) => {
      elicitationParts.push(part);
      // The call is now blocked on user input; it resumes when the
      // elicitation reaches a terminal status.
      lifecycle.transition('awaiting_user');
      context.onEvent?.({ type: 'mcp_elicitation', part });
    },
    (statusEvent) => {
      lifecycle.transition('running');
      context.onEvent?.({ type: 'mcp_elicitation_status', ...statusEvent });
    }
  );

  let cancelReason: McpElicitationCancelReason = 'tool_finished';
  try {
    const mcpResult = await executeResolvedMcpTool(context.userId, prepared.target, args, {
      signal: context.signal,
      toolCallId: callId,
    });
    // MCP tools usually report failure in CallToolResult (`isError: true`)
    // rather than throwing; treat that the same as a thrown tool failure for
    // any elicitation left pending when the call returns.
    const { isError } = mcpResult;
    if (isError) cancelReason = 'tool_failed';
    const mediaParts = isError
      ? undefined
      : await persistMcpMediaParts(mcpResult.content, {
          db: prepared.db,
          userId: context.userId,
          chatId: context.chatId,
          toolCallId: callId,
          serverSlug: prepared.target.parsed.serverSlug,
          toolName: prepared.target.parsed.toolName,
        });
    return {
      result: isError ? { error: mcpResult.contentText } : mcpResult.contentText,
      isError,
      ...(mediaParts?.length ? { mediaParts } : {}),
      ...(elicitationParts.length ? { elicitationParts } : {}),
    };
  } catch (error) {
    cancelReason = classifyMcpElicitationCancelReason(error, context.signal);
    throw error;
  } finally {
    releaseElicitationSink(context.userId, prepared.target.server.id, callId);
    cancelPendingElicitations(
      elicitationParts.map((part) => part.elicitationId),
      cancelReason
    );
  }
}

/**
 * Maps a thrown MCP call failure to the terminal reason exposed to elicitations.
 * Abort precedence mirrors `classifyToolExecutionFailure`: MCP SDK aborts can
 * surface as RequestTimeout, so the parent turn signal is authoritative.
 */
export function classifyMcpElicitationCancelReason(
  error: unknown,
  parentSignal?: AbortSignal
): McpElicitationCancelReason {
  if (isAbortError(error) || parentSignal?.aborted) return 'turn_aborted';
  const failure = classifyMcpCallFailure(error);
  if (failure === 'timeout') return 'tool_timeout';
  if (failure === 'server_closed') return 'server_closed';
  return 'tool_failed';
}

export function createDelegationRuntime(
  input: Omit<DelegationRuntime, 'onEvent'>
): DelegationRuntime | undefined {
  if (
    !shouldExposeDelegateTool({
      interactionMode: input.interactionMode,
      profile: input.parentAgentProfile,
      settings: input.settings,
    })
  ) {
    return undefined;
  }
  return input;
}

async function executeDelegationToolCall(
  callId: string,
  request: DelegateToSubagentRequest,
  runtime: DelegationRuntime
): Promise<SubagentRunResult> {
  if (runtime.state.subagentCallCount >= runtime.settings.maxSubagentCalls) {
    throw new SubagentDelegationError('Maximum subagent calls per turn reached.', 'MAX_CALLS');
  }

  runtime.state.subagentCallCount += 1;
  runtime.onEvent?.({
    type: 'system_event',
    event: 'subagent_delegation_started',
    detail: `call=${callId} target=${request.agentId}`,
  });

  const result = await runSubagentTurn({
    db: runtime.db,
    userId: runtime.userId,
    chatId: runtime.chatId,
    environmentId: runtime.environmentId,
    assistantMessageId: runtime.assistantMessageId,
    workdir: runtime.workdir,
    workdirPolicy: runtime.workdirPolicy,
    parentAgentProfile: runtime.parentAgentProfile,
    parentModelName: runtime.parentModelName,
    parentMode: runtime.interactionMode,
    settings: runtime.settings,
    request,
    depth: 0,
    signal: runtime.signal,
    onEvent: (event) => {
      if (event.type === 'text') {
        recordSubagentText(callId, event.agentId, event.text);
      }
      if (event.type === 'completed') {
        recordSubagentStatus(callId, event.agentId, event.agentName, 'completed');
      }
      if (event.type === 'failed') {
        if (event.agentName && isAgentId(event.agentId)) {
          recordSubagentStatus(callId, event.agentId, event.agentName, 'failed');
        }
      }
      runtime.onEvent?.(toSubagentStreamEvent(callId, event));
    },
  });
  recordSubagentResult(callId, result);

  runtime.onEvent?.({
    type: 'system_event',
    event:
      result.status === 'completed'
        ? 'subagent_delegation_completed'
        : 'subagent_delegation_failed',
    detail: `call=${callId} target=${result.agentId} status=${result.status} durationMs=${result.durationMs}`,
  });

  return result;
}

function toSubagentStreamEvent(callId: string, event: SubagentProgressEvent): ToolStreamEvent {
  switch (event.type) {
    case 'started':
      return {
        type: 'subagent_started',
        callId,
        agentId: event.agentId,
        agentName: event.agentName,
        task: event.task,
      };
    case 'text':
      return { type: 'subagent_text', callId, agentId: event.agentId, text: event.text };
    case 'tool_call_started':
      return {
        type: 'subagent_tool_call_started',
        callId,
        agentId: event.agentId,
        toolCallId: event.toolCallId,
        name: event.name,
      };
    case 'completed':
      return {
        type: 'subagent_completed',
        callId,
        agentId: event.agentId,
        agentName: event.agentName,
        summary: event.summary,
        toolCallCount: event.toolCallCount,
      };
    case 'failed':
      return {
        type: 'subagent_failed',
        callId,
        agentId: event.agentId,
        agentName: event.agentName,
        error: event.error,
      };
  }
}

function parseDelegationRequest(args: Record<string, unknown>): DelegateToSubagentRequest {
  const rawAgentId = getRequiredString(args.agentId, 'agentId');
  if (!isAgentId(rawAgentId)) {
    throw new SubagentDelegationError(
      `Invalid delegation target agent id "${rawAgentId}".`,
      'INVALID_AGENT_ID'
    );
  }
  const task = getRequiredString(args.task, 'task');
  const context = getOptionalString(args.context);
  const expectedOutput = getOptionalString(args.expectedOutput);
  const maxTurns = getBoundedOptionalInteger(args.maxTurns, 'maxTurns', {
    min: SUBAGENT_MAX_TURNS_MIN,
    max: SUBAGENT_MAX_TURNS_MAX,
  });

  return {
    agentId: rawAgentId,
    task,
    ...(context ? { context } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

function createSubagentTraceForTool(
  callId: string,
  result: SubagentRunResult
): Extract<MessagePart, { type: 'subagent_trace' }> {
  return {
    type: 'subagent_trace',
    toolCallId: callId,
    agentId: result.agentId,
    agentName: result.agentName,
    status: result.status,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    ...(result.trace.lastMessage ? { lastMessage: result.trace.lastMessage } : {}),
    messages: result.trace.messages,
    tools: result.trace.tools,
    ...(result.trace.events ? { events: result.trace.events } : {}),
    ...(result.trace.error ? { error: result.trace.error } : {}),
  };
}

function createSubagentToolResult(result: SubagentRunResult): Record<string, unknown> {
  return {
    agentId: result.agentId,
    agentName: result.agentName,
    status: result.status,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

/**
 * Rebuilds the question card payload from the args a successful
 * ask_user_question execution already validated.
 */
function createQuestionPart(callId: string, args: Record<string, unknown>): QuestionPart {
  return {
    type: 'question',
    toolCallId: callId,
    questions: parseAskUserQuestionArgs(args).questions,
  };
}

/**
 * Builds the checklist snapshot from a successful todo_write result, which
 * already carries the validated, persisted list.
 */
function createTodoPart(callId: string, result: unknown): TodoPart {
  const { todos } = result as TodoToolResult;
  return { type: 'todo', toolCallId: callId, todos };
}

function createFailedToolExecution(
  callId: string,
  name: string,
  argsStr: string,
  lifecycle: ToolExecutionLifecycle,
  error: unknown
): StandardToolExecution {
  lifecycle.fail(error);
  const result = { error: errorToToolMessage(error) };
  return {
    callId,
    name,
    args: parseToolArgs(argsStr),
    result,
    resultStr: stringifyToolResult(result),
    isError: true,
    execution: lifecycle.current,
  };
}

function createAsyncQueue<T>(): AsyncIterable<T> & {
  push: (item: T) => void;
  close: () => void;
} {
  const items: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: item, done: false });
        return;
      }
      items.push(item);
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const item = items.shift();
          if (item !== undefined) return Promise.resolve({ value: item, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function withToolTimeout<T>(
  promise: Promise<T>,
  name: string,
  timeoutMs: number,
  abortController?: AbortController
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController?.abort();
      reject(new ToolExecutionTimedOutError(`Tool "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}
