import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { SubagentTracePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { safeJsonParse } from '../../../lib/safe-parse';
import { executeMcpTool } from '../../../services/mcp/tool-bridge';
import { isMcpToolName } from '../../../services/mcp/tool-naming';
import {
  getProviderForModel,
  getProvider as getRegisteredProvider,
} from '../../../services/providers/core/provider-registry';
import type {
  AgentTurnRequest,
  AIProvider,
  ModelCapabilities,
  ToolDefinition,
} from '../../../services/providers/types';
import { executeTool, getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../../services/tools/builtin/ask-user-question';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import { TODO_READ_TOOL_NAME, TODO_WRITE_TOOL_NAME } from '../../../services/tools/builtin/todo';
import type { EffectiveToolSettings, WorkdirPolicy } from '../../../services/tools/types';
import { appendSkillsPromptSection } from '../../skills/application/skills-prompt-section';
import { appendWorkdirPromptSection } from '../../workspaces/application/workdir-prompt-section';
import type { ResolvedAgentRuntime } from './resolve-agent-runtime';
import { resolveAgentRuntime } from './resolve-agent-runtime';
import type { ResolvedModel } from './resolve-model';
import { resolveModel } from './resolve-model';
import type {
  DelegateToSubagentRequest,
  SubagentRuntimeInput,
  SubagentStatus,
} from './subagent-turn-types';
import {
  SUBAGENT_EMPTY_TEXT_FALLBACK,
  SUBAGENT_FAILED_CODE,
  SUBAGENT_SUMMARIZE_PROMPT,
  SubagentDelegationError,
  type SubagentRunResult,
} from './subagent-turn-types';

const subagentLogger = createDiagnosticLogger('subagent');

type LogValue = string | number | boolean;
type LogMetadata = Record<string, LogValue>;

export function logSubagentEvent(event: string, metadata: LogMetadata): void {
  subagentLogger.warn(event, metadata);
}

export function logSubagentError(event: string, metadata: LogMetadata): void {
  subagentLogger.error(event, metadata);
}

/** Mutable session state threaded through all subagent turn stages. */
export interface SubagentTurnSession {
  readonly input: SubagentRuntimeInput & {
    readonly targetProfile: AgentProfile;
    readonly signal: AbortSignal;
  };
  readonly resolvedModel: ResolvedModel;
  readonly provider: AIProvider;
  readonly runtime: ResolvedAgentRuntime;
  readonly toolDefinitions: ToolDefinition[];
  readonly allowedToolNames: Set<string>;
  readonly prompt: string;
  readonly transcript: Array<{ role: 'assistant' | 'system'; text: string }>;
  readonly tools: Array<{ callId: string; name: string; isError?: boolean }>;
  summary: string;
}

/**
 * Resolve model, provider, agent runtime, tool allowlist, and prompt for a
 * subagent turn. Returns the mutable session used by later stages.
 */
export async function prepareSubagentTurn(
  input: SubagentRuntimeInput & {
    readonly targetProfile: AgentProfile;
    readonly signal: AbortSignal;
  }
): Promise<SubagentTurnSession> {
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
  // Subagents can neither delegate further nor ask the human: their turn
  // result flows to the parent model, not the UI, so a question card would
  // never reach the user. The todo tools are also withheld — they operate on
  // the parent chat's single list, so a delegated task would clobber the
  // orchestrating plan.
  const subagentExcludedTools: ReadonlySet<string> = new Set([
    DELEGATE_TO_AGENT_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
    TODO_WRITE_TOOL_NAME,
    TODO_READ_TOOL_NAME,
  ]);
  const toolDefinitions = runtime.toolDefinitions.filter(
    (tool) => !subagentExcludedTools.has(tool.name)
  );
  const allowedToolNames = new Set(toolDefinitions.map((tool) => tool.name));
  const prompt = buildSubagentPrompt(input.request);

  // input.workdir is already scoped to agent-mode turns upstream: resolveTurnContext
  // drops the chat workdir in chat mode, so a chat-mode delegation (permitted when
  // chatDelegationEnabled) arrives here with workdir undefined. No parentMode guard
  // is needed — announcing input.workdir stays in lockstep with the tools that use it.
  const systemPrompt = appendWorkdirPromptSection(
    runtime.effectiveSystemPrompt,
    input.workdir,
    Boolean(input.workdirPolicy?.restricted)
  );

  return {
    input,
    resolvedModel,
    provider,
    runtime: {
      ...runtime,
      effectiveSystemPrompt: await appendSkillsPromptSection(
        input.db,
        input.userId,
        systemPrompt,
        allowedToolNames
      ),
    },
    toolDefinitions,
    allowedToolNames,
    prompt,
    transcript: [],
    tools: [],
    summary: '',
  };
}

/**
 * Stream text from a provider that lacks `generateAgentTurnStream`. Returns the
 * raw text; the orchestrator is responsible for enforcing a non-empty summary.
 */
export async function runPlainSubagentText(session: SubagentTurnSession): Promise<string> {
  return await generatePlainSubagentText({
    provider: session.provider,
    userId: session.input.userId,
    prompt: session.prompt,
    modelName: session.resolvedModel.modelId,
    systemPrompt: session.runtime.effectiveSystemPrompt,
    settings: session.runtime.runtimeSettings,
    signal: session.input.signal,
  });
}

/** Provider state after the stream loop completes, for downstream recovery. */
export interface SubagentStreamLoopResult {
  readonly providerState: string | null;
}

/**
 * Run the agent-stream tool loop: stream provider events, execute tool calls,
 * and accumulate transcript/tools/summary on the session. Returns the final
 * provider state for the recovery stage.
 */
export async function runSubagentStreamLoop(
  session: SubagentTurnSession
): Promise<SubagentStreamLoopResult> {
  const { input, resolvedModel, runtime, toolDefinitions, provider } = session;
  const generateAgentTurnStream = provider.generateAgentTurnStream;
  if (!generateAgentTurnStream) return { providerState: null };
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

    for await (const event of generateAgentTurnStream({
      userId: input.userId,
      chatId: input.chatId,
      workdir: input.workdir,
      workdirPolicy: input.workdirPolicy,
      modelName: resolvedModel.modelId,
      agentId: runtime.profile.id,
      agentRuntimeHash: runtime.runtimeHash,
      systemPrompt: runtime.effectiveSystemPrompt,
      history: [],
      prompt: isFirstIteration ? session.prompt : undefined,
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
        session.summary += event.text;
        input.onEvent?.({ type: 'text', agentId: runtime.profile.id, text: event.text });
      }
      if (event.type === 'reasoning_delta') {
        session.transcript.push({ role: 'system', text: event.text });
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
      db: input.db,
      userId: input.userId,
      chatId: input.chatId,
      allowedToolNames: session.allowedToolNames,
      settingsByToolName: runtime.toolSettingsByName,
      tools: session.tools,
      workdir: input.workdir,
      workdirPolicy: input.workdirPolicy,
      signal: input.signal,
    });
    isFirstIteration = false;
  }

  return { providerState };
}

/**
 * Run a follow-up summarize turn when the model produced tool calls but no
 * text. Returns the recovered text (may be empty). Appends nothing to the
 * session — the orchestrator decides whether to merge it into the summary.
 */
export async function recoverSubagentSummary(
  session: SubagentTurnSession,
  providerState: string | null
): Promise<string> {
  const { input, resolvedModel, runtime, provider } = session;

  logSubagentEvent('provider_completed_without_text', {
    chatId: input.chatId,
    userId: input.userId,
    agentId: runtime.profile.id,
    toolCallCount: session.tools.length,
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
    logSubagentEvent('summarize_turn_recovered', {
      chatId: input.chatId,
      userId: input.userId,
      agentId: runtime.profile.id,
      toolCallCount: session.tools.length,
      summaryLength: followUpText.length,
    });
  }

  return followUpText;
}

/**
 * Enforce a non-empty summary, append the assistant message to the transcript,
 * and build the completed {@link SubagentRunResult}.
 */
export function assembleSubagentResult(
  session: SubagentTurnSession,
  durationMs: number
): SubagentRunResult {
  const trimmedSummary = enforceSubagentSummary(session.summary.trim(), session.tools);
  session.transcript.push({ role: 'assistant', text: trimmedSummary });
  return createCompletedResult({
    profile: session.runtime.profile,
    summary: trimmedSummary,
    messages: session.transcript,
    tools: session.tools,
    modelName: session.resolvedModel.modelId,
    durationMs,
  });
}

// -- Shared helpers (used by stages and the outer runner) -------------------

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

export function enforceSubagentRunResult(result: SubagentRunResult): SubagentRunResult {
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

export function createFailedResult(input: {
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

// -- Private helpers (stage-local) -----------------------------------------

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
      if (chunk.type === 'error') {
        throw new SubagentDelegationError(
          chunk.content ?? 'Subagent provider stream failed.',
          SUBAGENT_FAILED_CODE
        );
      }
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
 * One follow-up streaming turn that forces the subagent to emit a final text
 * summary. The model is given NO tool definitions so it cannot dodge into
 * another tool call. Errors are swallowed — the caller falls back to a
 * synthesized tool summary.
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
  readonly db: Kysely<Database>;
  readonly userId: string;
  readonly chatId: string;
  readonly workdir?: string;
  readonly workdirPolicy?: WorkdirPolicy;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
  readonly tools: Array<{ callId: string; name: string; isError?: boolean }>;
  readonly signal: AbortSignal;
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
        if (isMcpToolName(call.name)) {
          if (input.settingsByToolName.get(call.name)?.enabled === false) {
            throw new SubagentDelegationError(
              `Tool "${call.name}" is disabled for this user.`,
              'TOOL_NOT_ALLOWED'
            );
          }
          const mcpResult = await executeMcpTool(
            input.db,
            input.userId,
            call.name,
            safeJsonParse(call.argsStr) ?? {},
            { signal: input.signal, toolCallId: callId }
          );
          if (mcpResult.isError) {
            result = { error: mcpResult.contentText };
            isError = true;
          } else {
            result = mcpResult.contentText;
          }
        } else {
          const tool = getTool(call.name);
          if (!tool)
            throw new SubagentDelegationError(`Unknown tool: "${call.name}"`, 'UNKNOWN_TOOL');
          result = await executeTool(
            call.name,
            safeJsonParse(call.argsStr) ?? {},
            {
              userId: input.userId,
              chatId: input.chatId,
              workdir: input.workdir,
              workdirPolicy: input.workdirPolicy,
              parameters: {},
            },
            getSafeEffectiveToolSettings(tool, input.settingsByToolName.get(call.name))
          );
        }
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
