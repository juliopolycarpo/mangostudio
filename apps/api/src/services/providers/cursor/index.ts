import { MAX_TOOL_ITERATIONS_DEFAULT } from '@mangostudio/shared/app-settings';
import type { ReasoningEffort, SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../lib/config';
import { stringifyToolResult } from '../../../modules/generation/application/tool-result-utils';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../tools/builtin/delegate-to-agent';
import { executeTool } from '../../tools/registry';
import { selectConnectorRowsForModel } from '../core/connector-model-rows';
import { withModelCache } from '../core/model-cache';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import { createProviderSecretService } from '../core/secret-service';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  GenerationConfig,
  ModelInfo,
  ModelParameterInfo,
  ProviderHealthcheckRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
  ToolDefinition,
} from '../types';
import {
  type CursorSidecarCustomTool,
  type CursorSidecarExecuteResult,
  type CursorSidecarRequest,
  streamCursorAgentSidecar,
} from './agent-runner';
import {
  CURSOR_TOOL_BUDGET_EXHAUSTED_MESSAGE,
  createBudgetedToolExecutor,
  createCursorAgentTurnMappingState,
  flushOutstandingToolResults,
  mapCursorChunkToAgentEvents,
} from './agent-turn';
import { CursorApiError, fetchCursorModels, validateCursorApiKey } from './client';
import { ensureCursorAgentHooks } from './hooks';
import { buildCursorAgentPrompt } from './prompt-builder';
import { detectCursorRuntimeAvailability } from './runtime-availability';
import { resolveCursorRuntimeUnavailableMessage } from './runtime-reason';

const secretService = createProviderSecretService({
  provider: 'cursor',
  tomlSection: 'cursor_api_keys',
  envVarPrefix: 'CURSOR_API_KEY',
  validateFn: (apiKey) => validateCursorApiKey(apiKey),
});

async function resolveClientConfig(
  userId: string,
  modelName?: string
): Promise<{ apiKey: string; workspaceDir: string }> {
  await secretService.syncConfigFileConnectors(userId);
  const rows = await secretService.listMeta('cursor', userId);

  for (const row of getCursorConnectorRowsForModel(rows, modelName)) {
    const apiKey = await secretService.resolveSecretValue(row);
    if (!apiKey) continue;
    return { apiKey, workspaceDir: resolveCursorWorkspaceDir() };
  }

  throw new CursorConnectorError('No Cursor API key is configured for the requested model.');
}

export function getCursorConnectorRowsForModel(
  rows: SecretMetadataRow[],
  modelName?: string
): SecretMetadataRow[] {
  return selectConnectorRowsForModel(rows, modelName);
}

function resolveCursorWorkspaceDir(): string {
  const configured = getConfig().cursor.workspaceDir.trim();
  return configured || process.cwd();
}

/** Maps allowlisted MangoStudio tool definitions to Cursor SDK customTools metadata. */
export function buildCursorCustomTools(
  tools: ToolDefinition[] | undefined
): CursorSidecarCustomTool[] | undefined {
  const allowed = (tools ?? []).filter((tool) => tool.name !== DELEGATE_TO_AGENT_TOOL_NAME);
  if (allowed.length === 0) return undefined;

  return allowed.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

function buildAllowedToolNameSet(tools: ToolDefinition[] | undefined): ReadonlySet<string> {
  return new Set(
    (tools ?? []).map((tool) => tool.name).filter((name) => name !== DELEGATE_TO_AGENT_TOOL_NAME)
  );
}

/** Context needed to execute a Cursor-routed tool through the API registry. */
interface CursorToolExecutionContext {
  userId: string;
  chatId: string;
  toolSettings?: GenerationConfig['toolSettings'];
}

async function executeCursorCustomTool(
  ctx: CursorToolExecutionContext,
  allowedToolNames: ReadonlySet<string>,
  name: string,
  args: Record<string, unknown>
): Promise<CursorSidecarExecuteResult> {
  if (!allowedToolNames.has(name)) {
    return { error: `Tool "${name}" is not allowed for this agent.`, isError: true };
  }

  try {
    const result = await executeTool(
      name,
      args,
      {
        userId: ctx.userId,
        chatId: ctx.chatId,
        parameters: {},
      },
      ctx.toolSettings?.[name]
    );
    return { result: stringifyToolResult(result) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Tool execution failed.',
      isError: true,
    };
  }
}

interface PreparedCursorSidecar {
  request: CursorSidecarRequest;
  executeCustomTool: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CursorSidecarExecuteResult>;
}

async function prepareCursorSidecar(params: {
  apiKey: string;
  model: string;
  prompt: string;
  modelParams?: Array<{ id: string; value: string }>;
  tools: ToolDefinition[] | undefined;
  toolExecution: CursorToolExecutionContext;
}): Promise<PreparedCursorSidecar> {
  const runtime = await detectCursorRuntimeAvailability();
  if (!runtime.available || !runtime.nodePath) {
    throw new CursorRuntimeUnavailableError(resolveCursorRuntimeUnavailableMessage(runtime));
  }

  const agentDir = await ensureCursorAgentHooks(runtime.nodePath);
  const customTools = buildCursorCustomTools(params.tools);
  const allowedToolNames = buildAllowedToolNameSet(params.tools);

  return {
    request: {
      apiKey: params.apiKey,
      model: params.model,
      cwd: agentDir,
      prompt: params.prompt,
      params: params.modelParams,
      ...(customTools ? { customTools } : {}),
      settingSources: ['project'],
    },
    executeCustomTool: (name, args) =>
      executeCursorCustomTool(params.toolExecution, allowedToolNames, name, args),
  };
}

const listModelsWithCache = withModelCache(
  async (userId: string): Promise<ModelInfo[]> => {
    await secretService.syncConfigFileConnectors(userId);
    const rows = await secretService.listMeta('cursor', userId);
    const configuredRows = rows.filter((row) => row.configured);
    if (configuredRows.length === 0) return [];

    const models = new Map<string, ModelInfo>();

    for (const row of configuredRows) {
      const apiKey = await secretService.resolveSecretValue(row);
      if (!apiKey) continue;
      const connectorModels = await listConnectorModels(row, apiKey);
      for (const model of connectorModels) models.set(model.modelId, model);
    }

    return Array.from(models.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
  { ttl: 3_600_000, fallback: [] }
);

function listConnectorModels(_row: SecretMetadataRow, apiKey: string): Promise<ModelInfo[]> {
  return fetchCursorModels({ apiKey });
}

interface PreparedCursorRuntime {
  readonly apiKey: string;
  readonly workspaceDir: string;
}

async function loadPreparedRuntime(
  userId: string,
  modelName?: string
): Promise<PreparedCursorRuntime> {
  const runtime = await detectCursorRuntimeAvailability();
  if (!runtime.available) {
    throw new CursorRuntimeUnavailableError(resolveCursorRuntimeUnavailableMessage(runtime));
  }

  const { apiKey, workspaceDir } = await resolveClientConfig(userId, modelName);
  return { apiKey, workspaceDir };
}

const CURSOR_THINKING_EFFORTS = ['low', 'medium', 'high'] as const;
type CursorThinkingEffort = (typeof CURSOR_THINKING_EFFORTS)[number];

function isCursorThinkingEffort(value: ReasoningEffort): value is CursorThinkingEffort {
  return (CURSOR_THINKING_EFFORTS as readonly ReasoningEffort[]).includes(value);
}

export function buildCursorModelParams(
  config: TextGenerationRequest['generationConfig'],
  modelParameters?: ModelParameterInfo[]
): Array<{ id: string; value: string }> | undefined {
  if (!config?.thinkingEnabled) return undefined;
  if (!config.reasoningEffort || !isCursorThinkingEffort(config.reasoningEffort)) return undefined;
  if (config.reasoningEffort === 'medium') return undefined;
  if (!modelParameters) return undefined;

  const thinkingParam = modelParameters.find((parameter) => parameter.id === 'thinking');
  if (!thinkingParam?.values.includes(config.reasoningEffort)) return undefined;

  return [{ id: 'thinking', value: config.reasoningEffort }];
}

async function resolveCursorModelParameters(
  userId: string,
  modelName: string
): Promise<ModelParameterInfo[] | undefined> {
  const models = await listModelsWithCache(userId);
  return models.find((model) => model.modelId === modelName)?.parameters;
}

const lifecycle = createProviderLifecycle<PreparedCursorRuntime>({
  provider: 'cursor',
  loadPreparedRuntime,
  invalidateCachedModels: listModelsWithCache.invalidate,
  syncConfigFileConnectors: secretService.syncConfigFileConnectors,
});

async function runCursorGeneration(req: TextGenerationRequest): Promise<string> {
  const { apiKey, workspaceDir } = await lifecycle.prepareRuntime(req.userId, req.modelName);
  const modelParameters = await resolveCursorModelParameters(req.userId, req.modelName);
  const prompt = buildCursorAgentPrompt({
    systemPrompt: req.systemPrompt,
    history: req.history,
    prompt: req.prompt,
    workspaceDir,
  });
  const modelParams = buildCursorModelParams(req.generationConfig, modelParameters);
  const sidecar = await prepareCursorSidecar({
    apiKey,
    model: req.modelName,
    prompt,
    modelParams,
    tools: req.generationConfig?.tools,
    toolExecution: {
      userId: req.userId,
      chatId: req.chatId ?? '',
      toolSettings: req.generationConfig?.toolSettings,
    },
  });

  let text = '';
  for await (const chunk of streamCursorAgentSidecar(sidecar.request, req.signal, {
    executeCustomTool: sidecar.executeCustomTool,
  })) {
    if (chunk.type === 'error') {
      throw new CursorConnectorError(chunk.content ?? 'Cursor agent run failed.');
    }
    if (chunk.type === 'text' && chunk.text) {
      text += chunk.text;
    }
    if (chunk.done) break;
  }

  if (!text.trim()) {
    throw new CursorConnectorError(`No text returned from Cursor model "${req.modelName}".`);
  }

  return text;
}

/**
 * Streams a full Cursor agent turn. The Cursor SDK owns the tool loop inside
 * the sidecar, so this adapter emits tool_result events itself and finishes
 * with turn_completed carrying no pending calls — the orchestrator completes
 * in a single iteration.
 */
async function* runCursorAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
  if (req.toolResults?.length) {
    throw new CursorConnectorError(
      'Cursor runs its tool loop inside the sidecar; the orchestrator must not feed back tool results.'
    );
  }

  const { apiKey, workspaceDir } = await lifecycle.prepareRuntime(req.userId, req.modelName);
  const modelParameters = await resolveCursorModelParameters(req.userId, req.modelName);
  const prompt = buildCursorAgentPrompt({
    systemPrompt: req.systemPrompt,
    history: req.history,
    prompt: req.prompt ?? '',
    workspaceDir,
  });
  const modelParams = buildCursorModelParams(req.generationConfig, modelParameters);
  const sidecar = await prepareCursorSidecar({
    apiKey,
    model: req.modelName,
    prompt,
    modelParams,
    tools: req.toolDefinitions,
    toolExecution: {
      userId: req.userId,
      chatId: req.chatId ?? '',
      toolSettings: req.generationConfig?.toolSettings,
    },
  });

  const abortController = new AbortController();
  const forwardAbort = () => abortController.abort();
  req.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (req.signal?.aborted) abortController.abort();

  const budgetedExecutor = createBudgetedToolExecutor({
    maxToolCalls: req.generationConfig?.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT,
    execute: sidecar.executeCustomTool,
    onExhausted: () => abortController.abort(),
  });

  const mappingState = createCursorAgentTurnMappingState();
  let sawError = false;

  try {
    for await (const chunk of streamCursorAgentSidecar(sidecar.request, abortController.signal, {
      executeCustomTool: budgetedExecutor.execute,
    })) {
      if (req.signal?.aborted || budgetedExecutor.isExhausted()) break;

      for (const event of mapCursorChunkToAgentEvents(chunk, mappingState)) {
        if (event.type === 'turn_error') sawError = true;
        yield event;
      }
      if (sawError) return;
      if (chunk.done) break;
    }
  } finally {
    req.signal?.removeEventListener('abort', forwardAbort);
    abortController.abort();
  }

  if (req.signal?.aborted) return;
  if (budgetedExecutor.isExhausted()) {
    yield { type: 'turn_error', error: CURSOR_TOOL_BUDGET_EXHAUSTED_MESSAGE };
    return;
  }

  yield* flushOutstandingToolResults(mappingState);
  yield { type: 'turn_completed' };
}

const cursorProvider: AIProvider = {
  providerType: 'cursor',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const text = await runCursorGeneration(req);
    return { text };
  },

  generateAgentTurnStream: runCursorAgentTurn,

  async *generateTextStream(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    const { apiKey, workspaceDir } = await lifecycle.prepareRuntime(req.userId, req.modelName);
    const modelParameters = await resolveCursorModelParameters(req.userId, req.modelName);
    const prompt = buildCursorAgentPrompt({
      systemPrompt: req.systemPrompt,
      history: req.history,
      prompt: req.prompt,
      workspaceDir,
    });
    const modelParams = buildCursorModelParams(req.generationConfig, modelParameters);
    const sidecar = await prepareCursorSidecar({
      apiKey,
      model: req.modelName,
      prompt,
      modelParams,
      tools: req.generationConfig?.tools,
      toolExecution: {
        userId: req.userId,
        chatId: req.chatId ?? '',
        toolSettings: req.generationConfig?.toolSettings,
      },
    });

    for await (const chunk of streamCursorAgentSidecar(sidecar.request, req.signal, {
      executeCustomTool: sidecar.executeCustomTool,
    })) {
      if (req.signal?.aborted) break;
      yield chunk;
      if (chunk.done) return;
    }
  },

  listModels(userId: string): Promise<ModelInfo[]> {
    return listModelsWithCache(userId);
  },

  invalidateModelCache: lifecycle.invalidateModelCache,
  syncConfigFileConnectors: lifecycle.syncConfigFileConnectors,
  warmup: lifecycle.warmup,

  async healthcheck(req: ProviderHealthcheckRequest): Promise<void> {
    if (!req.apiKey?.trim()) {
      throw new CursorApiError('Cursor API key is empty.');
    }

    const runtime = await detectCursorRuntimeAvailability();
    if (!runtime.available) {
      throw new CursorRuntimeUnavailableError(resolveCursorRuntimeUnavailableMessage(runtime));
    }

    await validateCursorApiKey(req.apiKey.trim());
  },

  async validateApiKey(apiKey: string): Promise<void> {
    await secretService.validateApiKey(apiKey);
  },

  async resolveApiKey(userId: string, modelName?: string): Promise<string> {
    const { apiKey } = await resolveClientConfig(userId, modelName);
    return apiKey;
  },
};

class CursorConnectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorConnectorError';
  }
}

export class CursorRuntimeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CursorRuntimeUnavailableError';
  }
}

export { cursorProvider };
