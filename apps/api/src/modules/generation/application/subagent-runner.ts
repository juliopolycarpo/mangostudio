import type { AgentId, AgentProfile } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { SubagentTracePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { safeJsonParse } from '../../../lib/safe-parse';
import {
  getProviderForModel,
  getProvider as getRegisteredProvider,
} from '../../../services/providers/core/provider-registry';
import type {
  AgentTurnRequest,
  AIProvider,
  ModelCapabilities,
} from '../../../services/providers/types';
import { executeTool, getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import type { EffectiveToolSettings } from '../../../services/tools/types';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { type ResolvedAgentRuntime, resolveAgentRuntime } from './resolve-agent-runtime';
import { resolveModel } from './resolve-model';

const SUBAGENT_TIMEOUT_CODE = 'TIMEOUT';
const SUBAGENT_ABORT_CODE = 'ABORTED';
const SUBAGENT_FAILED_CODE = 'FAILED';
export const SUBAGENT_EMPTY_TEXT_FALLBACK = 'Subagent completed without a text response.';
const subagentLogger = createDiagnosticLogger('subagent');
const SUBAGENT_SUMMARIZE_PROMPT =
  'Final summary required. Respond now in plain text only — do not call any tools. Summarise your findings: key points, relevant file paths or commands, and recommended next steps if any.';

export type SubagentStatus = 'completed' | 'failed' | 'aborted' | 'timeout';

export interface DelegateToSubagentRequest {
  readonly agentId: AgentId;
  readonly task: string;
  readonly context?: string;
  readonly expectedOutput?: string;
  readonly maxTurns?: number;
}

export type SubagentProgressEvent =
  | { type: 'started'; agentId: AgentId; agentName: string; task: string }
  | { type: 'text'; agentId: AgentId; text: string }
  | { type: 'tool_call_started'; agentId: AgentId; toolCallId: string; name: string }
  | {
      type: 'completed';
      agentId: AgentId;
      agentName: string;
      summary: string;
      toolCallCount: number;
    }
  | { type: 'failed'; agentId: string; agentName?: string; error: string };

export interface SubagentRunResult {
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly status: SubagentStatus;
  readonly summary: string;
  readonly messages: ReadonlyArray<{ role: 'assistant' | 'system'; text: string }>;
  readonly toolCallCount: number;
  readonly tools: ReadonlyArray<{ callId: string; name: string; isError?: boolean }>;
  readonly modelName?: string;
  readonly durationMs: number;
  readonly error?: { code: string; message: string };
  readonly trace: SubagentTracePart;
}

export interface SubagentRuntimeInput {
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly chatId: string;
  readonly parentAgentProfile: AgentProfile;
  readonly parentModelName: string;
  readonly parentMode: 'chat' | 'agent';
  readonly settings: MultiAgentSettings;
  readonly request: DelegateToSubagentRequest;
  readonly depth: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: SubagentProgressEvent) => void;
}

export class SubagentDelegationError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'SubagentDelegationError';
  }
}

export async function runSubagentTurn(input: SubagentRuntimeInput): Promise<SubagentRunResult> {
  assertDelegationAllowed(input);

  const startedAt = Date.now();
  const targetProfile = await getAgentProfile(input.db, input.userId, input.request.agentId);
  assertTargetAllowed(input.parentAgentProfile, targetProfile);
  logSubagentEvent('start', {
    chatId: input.chatId,
    userId: input.userId,
    parentAgentId: input.parentAgentProfile.id,
    targetAgentId: targetProfile.id,
    depth: input.depth,
  });
  input.onEvent?.({
    type: 'started',
    agentId: targetProfile.id,
    agentName: targetProfile.name,
    task: input.request.task,
  });

  const childAbort = createLinkedAbortController(input.signal);
  const timeout = setTimeout(
    () => childAbort.controller.abort(SUBAGENT_TIMEOUT_CODE),
    input.settings.timeoutMs
  );

  try {
    const result = await runWithTimeout(
      executeSubagentTurn({ ...input, targetProfile, signal: childAbort.controller.signal }),
      childAbort.controller.signal,
      input.settings.timeoutMs
    );
    if (!result.summary.trim()) {
      logSubagentEvent('empty_response_synthesized', {
        chatId: input.chatId,
        userId: input.userId,
        parentAgentId: input.parentAgentProfile.id,
        targetAgentId: result.agentId,
        toolCallCount: result.tools.length,
      });
    }
    const enforced = enforceSubagentRunResult(result);
    // If the original result had no summary, we synthesized a fallback, so emit it as text.
    if (!result.summary.trim()) {
      input.onEvent?.({ type: 'text', agentId: enforced.agentId, text: enforced.summary });
    }
    input.onEvent?.({
      type: 'completed',
      agentId: enforced.agentId,
      agentName: enforced.agentName,
      summary: enforced.summary,
      toolCallCount: enforced.toolCallCount,
    });
    logSubagentEvent('completed', {
      chatId: input.chatId,
      userId: input.userId,
      parentAgentId: input.parentAgentProfile.id,
      targetAgentId: enforced.agentId,
      status: enforced.status,
      toolCallCount: enforced.toolCallCount,
      summaryLength: enforced.summary.length,
      durationMs: enforced.durationMs,
    });
    return enforced;
  } catch (error) {
    const normalized = normalizeSubagentFailure(error, childAbort.controller.signal);
    input.onEvent?.({
      type: 'failed',
      agentId: targetProfile.id,
      agentName: targetProfile.name,
      error: normalized.message,
    });
    const failed = createFailedResult({
      profile: targetProfile,
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
      durationMs: Date.now() - startedAt,
    });
    logSubagentError('failed', {
      chatId: input.chatId,
      userId: input.userId,
      parentAgentId: input.parentAgentProfile.id,
      targetAgentId: targetProfile.id,
      status: failed.status,
      code: failed.error?.code ?? SUBAGENT_FAILED_CODE,
      message: failed.summary,
      durationMs: failed.durationMs,
    });
    return failed;
  } finally {
    clearTimeout(timeout);
    childAbort.dispose();
  }
}

function assertDelegationAllowed(input: SubagentRuntimeInput): void {
  if (!input.settings.enabled) {
    throw new SubagentDelegationError('Multi-agent delegation is disabled.', 'DISABLED');
  }
  if (input.parentMode === 'chat' && !input.settings.chatDelegationEnabled) {
    throw new SubagentDelegationError('Chat mode delegation is disabled.', 'CHAT_DISABLED');
  }
  if (input.depth >= input.settings.maxDepth) {
    throw new SubagentDelegationError('Maximum delegation depth reached.', 'MAX_DEPTH');
  }
}

function assertTargetAllowed(parent: AgentProfile, target: AgentProfile): void {
  if (!parent.subagentIds.includes(target.id)) {
    throw new SubagentDelegationError(
      `Agent "${target.id}" is not in the parent agent subagent allowlist.`,
      'TARGET_NOT_ALLOWED'
    );
  }
  if (target.role !== 'subagent' && target.role !== 'both') {
    throw new SubagentDelegationError(
      `Agent "${target.id}" cannot be used as a subagent.`,
      'INVALID_ROLE'
    );
  }
}

async function executeSubagentTurn(
  input: SubagentRuntimeInput & {
    readonly targetProfile: AgentProfile;
    readonly signal: AbortSignal;
  }
): Promise<SubagentRunResult> {
  const startedAt = Date.now();
  const resolvedModel = await resolveModel({
    requestedModel: input.targetProfile.model ?? input.parentModelName,
    userId: input.userId,
    type: 'text',
  });
  const provider = resolvedModel.providerType
    ? getRegisteredProvider(resolvedModel.providerType)
    : await getProviderForModel(resolvedModel.modelId, input.userId);
  const runtime = await resolveAgentRuntime({
    db: input.db,
    userId: input.userId,
    agentMode: 'agent',
    agentId: input.targetProfile.id,
    provider: provider.providerType,
    requestRuntimeSettings: getSubagentRuntimeSettings(input.targetProfile),
    profile: input.targetProfile,
  });
  const toolDefinitions = runtime.toolDefinitions.filter(
    (tool) => tool.name !== DELEGATE_TO_AGENT_TOOL_NAME
  );
  const allowedToolNames = new Set(toolDefinitions.map((tool) => tool.name));
  const prompt = buildSubagentPrompt(input.request);
  const transcript: Array<{ role: 'assistant' | 'system'; text: string }> = [];
  const tools: Array<{ callId: string; name: string; isError?: boolean }> = [];
  let summary = '';

  if (!provider.generateAgentTurnStream) {
    const text = await generatePlainSubagentText({
      provider,
      userId: input.userId,
      prompt,
      modelName: resolvedModel.modelId,
      systemPrompt: runtime.effectiveSystemPrompt,
      settings: runtime.runtimeSettings,
      signal: input.signal,
    });
    summary = enforceSubagentSummary(text.trim(), tools);
    transcript.push({ role: 'assistant', text: summary });
    input.onEvent?.({ type: 'text', agentId: runtime.profile.id, text: summary });
    return createCompletedResult({
      profile: runtime.profile,
      summary,
      messages: transcript,
      tools,
      modelName: resolvedModel.modelId,
      durationMs: Date.now() - startedAt,
    });
  }

  const maxTurns = Math.min(
    input.request.maxTurns ?? input.settings.defaultMaxTurns,
    input.settings.defaultMaxTurns
  );
  let toolResults: AgentTurnRequest['toolResults'];
  let providerState: string | null = null;
  let isFirstIteration = true;

  for (let iteration = 0; iteration < maxTurns; iteration++) {
    assertSubagentActive(input.signal);
    const pendingCalls = new Map<string, { name: string; argsStr: string }>();
    let turnCompleted = false;

    for await (const event of provider.generateAgentTurnStream({
      userId: input.userId,
      modelName: resolvedModel.modelId,
      agentId: runtime.profile.id,
      agentRuntimeHash: runtime.runtimeHash,
      systemPrompt: runtime.effectiveSystemPrompt,
      history: [],
      prompt: isFirstIteration ? prompt : undefined,
      toolResults,
      toolDefinitions,
      providerState,
      signal: input.signal,
      modelCapabilities: resolvedModel.capabilities,
      generationConfig: {
        thinkingEnabled: runtime.runtimeSettings.thinkingEnabled ?? true,
        reasoningEffort: runtime.runtimeSettings.reasoningEffort ?? 'medium',
        maxToolIterations: maxTurns,
        maxOutputTokens: runtime.runtimeSettings.maxOutputTokens,
        promptCachePreference: runtime.runtimeSettings.promptCachePreference,
        parallelToolCallsEnabled: runtime.runtimeSettings.parallelToolCallsEnabled,
      },
    })) {
      assertSubagentActive(input.signal);
      if (event.type === 'assistant_text_delta') {
        summary += event.text;
        input.onEvent?.({ type: 'text', agentId: runtime.profile.id, text: event.text });
      }
      if (event.type === 'reasoning_delta') {
        transcript.push({ role: 'system', text: event.text });
      }
      if (event.type === 'tool_call_started') {
        pendingCalls.set(event.callId, { name: event.name ?? '', argsStr: '' });
        input.onEvent?.({
          type: 'tool_call_started',
          agentId: runtime.profile.id,
          toolCallId: event.callId,
          name: event.name ?? '',
        });
      }
      if (event.type === 'tool_call_arguments_delta') {
        const call = pendingCalls.get(event.callId);
        if (call) call.argsStr += event.delta;
      }
      if (event.type === 'tool_call_completed') {
        pendingCalls.set(event.callId, { name: event.name, argsStr: event.arguments });
      }
      if (event.type === 'turn_completed') {
        providerState = event.providerState ?? null;
        turnCompleted = true;
      }
      if (event.type === 'turn_error') {
        throw new SubagentDelegationError(event.error, SUBAGENT_FAILED_CODE);
      }
    }

    if (!turnCompleted || pendingCalls.size === 0) break;
    toolResults = await executeSubagentTools({
      calls: pendingCalls,
      userId: input.userId,
      chatId: input.chatId,
      allowedToolNames,
      settingsByToolName: runtime.toolSettingsByName,
      tools,
    });
    isFirstIteration = false;
  }

  if (!summary.trim() && tools.length > 0) {
    logSubagentEvent('provider_completed_without_text', {
      chatId: input.chatId,
      userId: input.userId,
      agentId: runtime.profile.id,
      toolCallCount: tools.length,
    });
    const followUpText = await streamSubagentSummarizeTurn({
      provider,
      userId: input.userId,
      modelName: resolvedModel.modelId,
      runtime,
      providerState,
      signal: input.signal,
      modelCapabilities: resolvedModel.capabilities,
      onTextDelta: (text) => {
        input.onEvent?.({ type: 'text', agentId: runtime.profile.id, text });
      },
    });
    if (followUpText.trim()) {
      summary += followUpText;
      logSubagentEvent('summarize_turn_recovered', {
        chatId: input.chatId,
        userId: input.userId,
        agentId: runtime.profile.id,
        toolCallCount: tools.length,
        summaryLength: followUpText.length,
      });
    }
  }
  const trimmedSummary = enforceSubagentSummary(summary.trim(), tools);
  transcript.push({ role: 'assistant', text: trimmedSummary });

  return createCompletedResult({
    profile: runtime.profile,
    summary: trimmedSummary,
    messages: transcript,
    tools,
    modelName: resolvedModel.modelId,
    durationMs: Date.now() - startedAt,
  });
}

async function generatePlainSubagentText(input: {
  readonly provider: AIProvider;
  readonly userId: string;
  readonly prompt: string;
  readonly modelName: string;
  readonly systemPrompt?: string;
  readonly settings: ProviderRuntimeSettings;
  readonly signal: AbortSignal;
}): Promise<string> {
  if (input.provider.generateTextStream) {
    let text = '';
    for await (const chunk of input.provider.generateTextStream({
      userId: input.userId,
      history: [],
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      modelName: input.modelName,
      signal: input.signal,
      generationConfig: {
        thinkingEnabled: input.settings.thinkingEnabled ?? true,
        reasoningEffort: input.settings.reasoningEffort ?? 'medium',
      },
    })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    return text;
  }

  const result = await input.provider.generateText({
    userId: input.userId,
    history: [],
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    modelName: input.modelName,
    signal: input.signal,
    generationConfig: {
      thinkingEnabled: input.settings.thinkingEnabled ?? true,
      reasoningEffort: input.settings.reasoningEffort ?? 'medium',
    },
  });
  return result.text;
}

/**
 * One follow-up streaming turn that forces the subagent to emit a final text summary.
 * The model is given NO tool definitions so it cannot dodge into another tool call.
 * Errors are swallowed — the caller falls back to a synthesized tool summary.
 */
async function streamSubagentSummarizeTurn(input: {
  readonly provider: AIProvider;
  readonly userId: string;
  readonly modelName: string;
  readonly runtime: ResolvedAgentRuntime;
  readonly providerState: string | null;
  readonly signal: AbortSignal;
  readonly modelCapabilities?: ModelCapabilities;
  readonly onTextDelta?: (text: string) => void;
}): Promise<string> {
  if (!input.provider.generateAgentTurnStream) return '';
  let text = '';
  try {
    for await (const event of input.provider.generateAgentTurnStream({
      userId: input.userId,
      modelName: input.modelName,
      agentId: input.runtime.profile.id,
      agentRuntimeHash: input.runtime.runtimeHash,
      systemPrompt: input.runtime.effectiveSystemPrompt,
      history: [],
      prompt: SUBAGENT_SUMMARIZE_PROMPT,
      toolResults: undefined,
      toolDefinitions: [],
      providerState: input.providerState,
      signal: input.signal,
      modelCapabilities: input.modelCapabilities,
      generationConfig: {
        thinkingEnabled: input.runtime.runtimeSettings.thinkingEnabled ?? true,
        reasoningEffort: input.runtime.runtimeSettings.reasoningEffort ?? 'medium',
        maxToolIterations: 1,
        maxOutputTokens: input.runtime.runtimeSettings.maxOutputTokens,
        promptCachePreference: input.runtime.runtimeSettings.promptCachePreference,
        parallelToolCallsEnabled: false,
      },
    })) {
      if (input.signal.aborted) break;
      if (event.type === 'assistant_text_delta') {
        text += event.text;
        input.onTextDelta?.(event.text);
      }
      if (event.type === 'turn_completed') break;
      if (event.type === 'turn_error') break;
    }
  } catch {
    // Swallow: the caller will fall back to the synthesized tool summary.
  }
  return text;
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
async function executeSubagentTools(input: {
  readonly calls: ReadonlyMap<string, { name: string; argsStr: string }>;
  readonly userId: string;
  readonly chatId: string;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
  readonly tools: Array<{ callId: string; name: string; isError?: boolean }>;
}): Promise<NonNullable<AgentTurnRequest['toolResults']>> {
  return Promise.all(
    Array.from(input.calls.entries()).map(async ([callId, call]) => {
      let result: unknown;
      let isError = false;
      const startedAt = Date.now();
      logSubagentEvent('tool_call', {
        chatId: input.chatId,
        userId: input.userId,
        callId,
        tool: call.name,
        argsBytes: call.argsStr.length,
      });
      try {
        if (call.name === DELEGATE_TO_AGENT_TOOL_NAME) {
          throw new SubagentDelegationError(
            'Subagents cannot delegate to other agents.',
            'MAX_DEPTH'
          );
        }
        if (!input.allowedToolNames.has(call.name)) {
          throw new SubagentDelegationError(
            `Tool "${call.name}" is not allowed for this subagent.`,
            'TOOL_NOT_ALLOWED'
          );
        }
        const tool = getTool(call.name);
        if (!tool)
          throw new SubagentDelegationError(`Unknown tool: "${call.name}"`, 'UNKNOWN_TOOL');
        result = await executeTool(
          call.name,
          safeJsonParse(call.argsStr) ?? {},
          { userId: input.userId, chatId: input.chatId, parameters: {} },
          getSafeEffectiveToolSettings(tool, input.settingsByToolName.get(call.name))
        );
      } catch (error) {
        result = { error: error instanceof Error ? error.message : 'Subagent tool failed' };
        isError = true;
      }

      input.tools.push({ callId, name: call.name, ...(isError ? { isError } : {}) });
      logSubagentEvent(isError ? 'tool_error' : 'tool_completed', {
        chatId: input.chatId,
        userId: input.userId,
        callId,
        tool: call.name,
        durationMs: Date.now() - startedAt,
      });
      return {
        callId,
        name: call.name,
        result: stringifySubagentToolResult(result),
        isError,
      };
    })
  );
}

function assertSubagentActive(signal: AbortSignal): void {
  if (signal.aborted) throw new SubagentDelegationError('Subagent aborted.', 'ABORTED');
}

function stringifySubagentToolResult(result: unknown): string {
  const serialized = JSON.stringify(result);
  return typeof serialized === 'string' ? serialized : 'null';
}

function buildSubagentPrompt(request: DelegateToSubagentRequest): string {
  const sections = [
    `Task:\n${request.task}`,
    'Response requirements:\n- Always end with a concise, plain-text summary of your findings.\n- If you only used tools, summarise the tool outcomes instead of returning an empty response.\n- Do not finish immediately after tool calls without a final summary.',
  ];
  if (request.context) sections.push(`Context:\n${request.context}`);
  if (request.expectedOutput) sections.push(`Expected output:\n${request.expectedOutput}`);
  return sections.join('\n\n');
}

function getSubagentRuntimeSettings(profile: AgentProfile): Partial<ProviderRuntimeSettings> {
  return {
    ...(profile.thinkingEnabled !== undefined ? { thinkingEnabled: profile.thinkingEnabled } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.maxToolIterations !== undefined
      ? { maxToolIterations: profile.maxToolIterations }
      : {}),
  };
}

interface LinkedAbortController {
  readonly controller: AbortController;
  readonly dispose: () => void;
}

const noop = (): void => undefined;

function createLinkedAbortController(parent?: AbortSignal): LinkedAbortController {
  const controller = new AbortController();
  if (!parent) return { controller, dispose: noop };
  if (parent.aborted) {
    controller.abort(SUBAGENT_ABORT_CODE);
    return { controller, dispose: noop };
  }
  const onParentAbort = () => controller.abort(SUBAGENT_ABORT_CODE);
  parent.addEventListener('abort', onParentAbort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener('abort', onParentAbort),
  };
}

function runWithTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new SubagentDelegationError(`Subagent timed out after ${timeoutMs}ms.`, 'TIMEOUT'));
    }, timeoutMs);
  });

  if (signal.aborted) {
    return Promise.reject(new SubagentDelegationError('Subagent aborted.', 'ABORTED'));
  }

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function normalizeSubagentFailure(
  error: unknown,
  signal: AbortSignal
): { status: Exclude<SubagentStatus, 'completed'>; code: string; message: string } {
  if (signal.aborted && signal.reason === SUBAGENT_TIMEOUT_CODE) {
    return { status: 'timeout', code: SUBAGENT_TIMEOUT_CODE, message: 'Subagent timed out.' };
  }
  if (signal.aborted) {
    return { status: 'aborted', code: SUBAGENT_ABORT_CODE, message: 'Subagent aborted.' };
  }
  if (error instanceof SubagentDelegationError && error.code === 'TIMEOUT') {
    return { status: 'timeout', code: SUBAGENT_TIMEOUT_CODE, message: error.message };
  }
  if (error instanceof Error) {
    return { status: 'failed', code: SUBAGENT_FAILED_CODE, message: error.message };
  }
  return { status: 'failed', code: SUBAGENT_FAILED_CODE, message: 'Subagent failed.' };
}

function createCompletedResult(input: {
  readonly profile: AgentProfile;
  readonly summary: string;
  readonly messages: ReadonlyArray<{ role: 'assistant' | 'system'; text: string }>;
  readonly tools: ReadonlyArray<{ callId: string; name: string; isError?: boolean }>;
  readonly modelName?: string;
  readonly durationMs: number;
}): SubagentRunResult {
  const trace = createTracePart({
    profile: input.profile,
    status: 'completed',
    summary: input.summary,
    messages: input.messages,
    tools: input.tools,
  });
  return {
    agentId: input.profile.id,
    agentName: input.profile.name,
    status: 'completed',
    summary: input.summary,
    messages: input.messages,
    toolCallCount: input.tools.length,
    tools: input.tools,
    modelName: input.modelName,
    durationMs: input.durationMs,
    trace,
  };
}

function createFailedResult(input: {
  readonly profile: AgentProfile;
  readonly status: Exclude<SubagentStatus, 'completed'>;
  readonly code: string;
  readonly message: string;
  readonly durationMs: number;
}): SubagentRunResult {
  const messages = [{ role: 'assistant' as const, text: input.message }];
  const trace = createTracePart({
    profile: input.profile,
    status: input.status,
    summary: input.message,
    messages,
    tools: [],
    error: input.message,
  });
  return {
    agentId: input.profile.id,
    agentName: input.profile.name,
    status: input.status,
    summary: input.message,
    messages,
    toolCallCount: 0,
    tools: [],
    durationMs: input.durationMs,
    error: { code: input.code, message: input.message },
    trace,
  };
}

function createTracePart(input: {
  readonly profile: AgentProfile;
  readonly status: SubagentStatus;
  readonly summary: string;
  readonly messages: ReadonlyArray<{ role: 'assistant' | 'system'; text: string }>;
  readonly tools: ReadonlyArray<{ callId: string; name: string; isError?: boolean }>;
  readonly error?: string;
}): SubagentTracePart {
  const summaryText = input.summary.trim();
  const lastMessage =
    [...input.messages].reverse().find((message) => message.text.trim())?.text ??
    (summaryText ? summaryText : undefined);
  return {
    type: 'subagent_trace',
    toolCallId: '',
    agentId: input.profile.id,
    agentName: input.profile.name,
    status: input.status,
    summary: input.summary,
    toolCallCount: input.tools.length,
    ...(lastMessage ? { lastMessage } : {}),
    messages: input.messages,
    tools: input.tools,
    ...(input.error ? { error: input.error } : {}),
  };
}

function enforceSubagentSummary(summary: string, tools: ReadonlyArray<{ name: string }>): string {
  const trimmed = summary.trim();
  if (trimmed) return trimmed;
  if (tools.length === 0) return SUBAGENT_EMPTY_TEXT_FALLBACK;

  const names = tools.map((tool) => tool.name).filter(Boolean);
  const unique = Array.from(new Set(names));
  const shown = unique.slice(0, 8);
  const suffix = unique.length > shown.length ? ` (+${unique.length - shown.length} more)` : '';
  return `${SUBAGENT_EMPTY_TEXT_FALLBACK} Tools executed: ${shown.join(', ')}${suffix}.`;
}

function enforceSubagentRunResult(result: SubagentRunResult): SubagentRunResult {
  const summary = enforceSubagentSummary(result.summary, result.tools);
  const messages = result.messages.some(
    (message) => message.role === 'assistant' && message.text.trim()
  )
    ? result.messages
    : [...result.messages, { role: 'assistant' as const, text: summary }];
  const trace = {
    ...result.trace,
    summary,
    messages,
    ...(result.trace.lastMessage ? {} : { lastMessage: summary }),
  };
  return {
    ...result,
    summary,
    messages,
    trace,
    toolCallCount: result.tools.length,
  };
}

type LogValue = string | number | boolean;
type LogMetadata = Record<string, LogValue>;

function logSubagentEvent(event: string, metadata: LogMetadata): void {
  subagentLogger.warn(event, metadata);
}

function logSubagentError(event: string, metadata: LogMetadata): void {
  subagentLogger.error(event, metadata);
}
