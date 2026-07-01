import type { ReasoningEffort, SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../lib/config';
import { stringifyToolResult } from '../../../modules/generation/application/tool-result-utils';
import { parseStringArray } from '../../../utils/json';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../tools/builtin/delegate-to-agent';
import { executeTool } from '../../tools/registry';
import { withModelCache } from '../core/model-cache';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import { createProviderSecretService } from '../core/secret-service';
import type {
  AIProvider,
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
import { CursorApiError, fetchCursorModels, validateCursorApiKey } from './client';
import { ensureCursorAgentHooks } from './hooks';
import { buildCursorAgentPrompt } from './prompt-builder';
import { detectCursorRuntimeAvailability } from './runtime-availability';

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
  const configuredRows = rows.filter((row) => row.configured);
  if (!modelName) return configuredRows;

  const explicitMatches: SecretMetadataRow[] = [];
  const fallbackMatches: SecretMetadataRow[] = [];

  for (const row of configuredRows) {
    const enabled = parseStringArray(row.enabledModels);
    if (enabled.includes(modelName)) {
      explicitMatches.push(row);
    } else if (enabled.length === 0) {
      fallbackMatches.push(row);
    }
  }

  return [...explicitMatches, ...fallbackMatches];
}

function resolveCursorWorkspaceDir(): string {
  const configured = getConfig().cursor.workspaceDir.trim();
  return configured || process.cwd();
}

/** Maps allowlisted MangoStudio tool definitions to Cursor SDK customTools metadata. */
export function buildCursorCustomTools(
  config: TextGenerationRequest['generationConfig']
): CursorSidecarCustomTool[] | undefined {
  const tools = (config?.tools ?? []).filter((tool) => tool.name !== DELEGATE_TO_AGENT_TOOL_NAME);
  if (tools.length === 0) return undefined;

  return tools.map((tool) => ({
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

async function executeCursorCustomTool(
  req: TextGenerationRequest,
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
        userId: req.userId,
        chatId: req.chatId ?? '',
        parameters: {},
      },
      req.generationConfig?.toolSettings?.[name]
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

async function prepareCursorSidecar(
  req: TextGenerationRequest,
  params: {
    apiKey: string;
    workspaceDir: string;
    model: string;
    prompt: string;
    modelParams?: Array<{ id: string; value: string }>;
  }
): Promise<PreparedCursorSidecar> {
  const runtime = await detectCursorRuntimeAvailability();
  if (!runtime.available || !runtime.nodePath) {
    throw new CursorRuntimeUnavailableError(
      runtime.reason ?? 'Node.js is required for Cursor SDK agents.'
    );
  }

  const agentDir = await ensureCursorAgentHooks(runtime.nodePath);
  const customTools = buildCursorCustomTools(req.generationConfig);
  const allowedToolNames = buildAllowedToolNameSet(req.generationConfig?.tools);

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
    executeCustomTool: (name, args) => executeCursorCustomTool(req, allowedToolNames, name, args),
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
    throw new CursorRuntimeUnavailableError(
      runtime.reason ?? 'Node.js is required for Cursor SDK agents.'
    );
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
  const sidecar = await prepareCursorSidecar(req, {
    apiKey,
    workspaceDir,
    model: req.modelName,
    prompt,
    modelParams,
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

const cursorProvider: AIProvider = {
  providerType: 'cursor',

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const text = await runCursorGeneration(req);
    return { text };
  },

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
    const sidecar = await prepareCursorSidecar(req, {
      apiKey,
      workspaceDir,
      model: req.modelName,
      prompt,
      modelParams,
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
      throw new CursorRuntimeUnavailableError(
        runtime.reason ?? 'Node.js is required for Cursor SDK agents.'
      );
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

export class CursorConnectorError extends Error {
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
