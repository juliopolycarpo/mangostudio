import type { MessagePart } from '@mangostudio/shared';
import type { AgentProfile } from '@mangostudio/shared/agents';
import { isAgentId } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { SUBAGENT_MAX_TURNS_MAX, SUBAGENT_MAX_TURNS_MIN } from '@mangostudio/shared/app-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import { executeTool, getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import {
  getBoundedOptionalInteger,
  getOptionalString,
  getRequiredString,
} from '../../../services/tools/arg-parsing';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import type { EffectiveToolSettings } from '../../../services/tools/types';
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

const TOOL_TIMEOUT_MS = 30_000;

export interface StandardToolExecution {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  resultStr: string;
  isError: boolean;
  subagentTrace?: Extract<MessagePart, { type: 'subagent_trace' }>;
}

export interface DelegationRuntime {
  db: Kysely<Database>;
  userId: string;
  chatId: string;
  parentAgentProfile: AgentProfile;
  parentModelName: string;
  interactionMode: 'chat' | 'agent';
  settings: MultiAgentSettings;
  signal?: AbortSignal;
  state: { subagentCallCount: number };
  onEvent?: (event: StreamEvent) => void;
}

export type StreamEvent =
  | { type: 'system_event'; event: string; detail: string }
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
  | { kind: 'event'; event: StreamEvent }
  | { kind: 'execution'; execution: StandardToolExecution };

export async function* executeStandardToolCallsWithProgress(
  calls: ReadonlyArray<[string, { name: string; argsStr: string }]>,
  context: {
    userId: string;
    chatId: string;
    settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
    allowedToolNames: ReadonlySet<string>;
    delegationRuntime?: DelegationRuntime;
  }
): AsyncGenerator<ToolExecutionProgressItem> {
  // No calls means no completion callbacks ever fire, so the queue would never
  // close and `yield* queue` would hang. Exit before arming the queue.
  if (calls.length === 0) return;

  const queue = createAsyncQueue<ToolExecutionProgressItem>();
  let remaining = calls.length;

  for (const [callId, call] of calls) {
    const runtime = context.delegationRuntime
      ? {
          ...context.delegationRuntime,
          onEvent: (event: StreamEvent) => queue.push({ kind: 'event', event }),
        }
      : undefined;
    void executeStandardToolCall(callId, call.name, call.argsStr, {
      ...context,
      delegationRuntime: runtime,
    })
      .then((execution) => queue.push({ kind: 'execution', execution }))
      .catch((error: unknown) =>
        queue.push({
          kind: 'execution',
          execution: createFailedToolExecution(callId, call.name, call.argsStr, error),
        })
      )
      .finally(() => {
        remaining -= 1;
        if (remaining === 0) queue.close();
      });
  }

  yield* queue;
}

export async function executeStandardToolCall(
  callId: string,
  name: string,
  argsStr: string,
  context: {
    userId: string;
    chatId: string;
    settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
    allowedToolNames: ReadonlySet<string>;
    delegationRuntime?: DelegationRuntime;
  }
): Promise<StandardToolExecution> {
  const args = parseToolArgs(argsStr);
  let result: unknown;
  let isError = false;
  let subagentTrace: Extract<MessagePart, { type: 'subagent_trace' }> | undefined;
  const isDelegationTool =
    name === DELEGATE_TO_AGENT_TOOL_NAME && Boolean(context.delegationRuntime);

  try {
    if (!context.allowedToolNames.has(name)) {
      throw new Error(`Tool "${name}" is not allowed for this agent.`);
    }
    const runtime = context.delegationRuntime;
    if (name === DELEGATE_TO_AGENT_TOOL_NAME && runtime) {
      const tool = getTool(name);
      if (!tool) throw new Error(`Unknown tool: "${name}"`);
      const effectiveSettings = getSafeEffectiveToolSettings(
        tool,
        context.settingsByToolName.get(name)
      );
      if (!effectiveSettings.enabled) {
        throw new Error(`Tool "${name}" is disabled for this user.`);
      }
      const request = parseDelegationRequest(args);
      // Retry/cache-recovery wraps each single-attempt delegation; the per-call
      // runtime carries the abort signal, timeout, and the onEvent sink that
      // streams subagent progress back to the caller.
      result = await ensureDelegationResult(callId, request, {
        signal: runtime.signal,
        timeoutMs: runtime.settings.timeoutMs,
        onEvent: runtime.onEvent,
        executeDelegation: (delegationCallId, delegationRequest) =>
          executeDelegationToolCall(delegationCallId, delegationRequest, runtime),
      });
    } else {
      result = await withToolTimeout(
        executeTool(
          name,
          args,
          {
            userId: context.userId,
            chatId: context.chatId,
            parameters: {},
          },
          context.settingsByToolName.get(name)
        ),
        name
      );
    }
    if (isSubagentRunResult(result)) {
      subagentTrace = createSubagentTraceForTool(callId, result);
      isError = result.status !== 'completed';
    }
  } catch (error) {
    result = { error: errorToToolMessage(error) };
    isError = true;
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
  const providerResult = isSubagentRunResult(result) ? createSubagentToolResult(result) : result;

  return {
    callId,
    name,
    args,
    result: providerResult,
    resultStr: stringifyToolResult(providerResult),
    isError,
    ...(subagentTrace ? { subagentTrace } : {}),
  };
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

export function shouldExposeDelegateTool(input: {
  readonly interactionMode: 'chat' | 'agent';
  readonly profile: AgentProfile;
  readonly settings: MultiAgentSettings;
}): boolean {
  if (!input.settings.enabled) return false;
  if (input.settings.maxDepth < 1) return false;
  if (input.settings.maxSubagentCalls < 1) return false;
  if (input.profile.subagentIds.length === 0) return false;
  if (input.interactionMode === 'chat') return input.settings.chatDelegationEnabled;
  return true;
}

export async function executeDelegationToolCall(
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

export function toSubagentStreamEvent(callId: string, event: SubagentProgressEvent): StreamEvent {
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

export function parseDelegationRequest(args: Record<string, unknown>): DelegateToSubagentRequest {
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

function createFailedToolExecution(
  callId: string,
  name: string,
  argsStr: string,
  error: unknown
): StandardToolExecution {
  const result = { error: errorToToolMessage(error) };
  return {
    callId,
    name,
    args: parseToolArgs(argsStr),
    result,
    resultStr: stringifyToolResult(result),
    isError: true,
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

export function parseToolArgs(argsStr: string): Record<string, unknown> {
  return safeJsonParse(argsStr) ?? {};
}

function withToolTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
      TOOL_TIMEOUT_MS
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export function stringifyToolResult(result: unknown): string {
  try {
    const serialized = JSON.stringify(result);
    return typeof serialized === 'string' ? serialized : 'null';
  } catch {
    return JSON.stringify({ error: 'Tool result serialization failed.' });
  }
}

export function errorToToolMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool execution failed';
}
