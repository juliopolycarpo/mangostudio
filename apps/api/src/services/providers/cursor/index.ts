import type { ReasoningEffort, SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../lib/config';
import { parseStringArray } from '../../../utils/json';
import { findShellExecutable, type ShellKind } from '../../tools/builtin/_shell-exec';
import { normalizeShellToolSettings } from '../../tools/builtin/_shell-tool';
import { withModelCache } from '../core/model-cache';
import { createProviderLifecycle } from '../core/provider-lifecycle';
import { createProviderSecretService } from '../core/secret-service';
import type {
  AIProvider,
  ModelInfo,
  ProviderHealthcheckRequest,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';
import { type CursorSidecarShellTool, streamCursorAgentSidecar } from './agent-runner';
import { CursorApiError, fetchCursorModels, validateCursorApiKey } from './client';
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

const CURSOR_SHELL_TOOL_NAMES = [
  'bash',
  'zsh',
  'powershell',
] as const satisfies readonly ShellKind[];

function buildCursorShellTools(
  config: TextGenerationRequest['generationConfig']
): CursorSidecarShellTool[] | undefined {
  const definitions = new Map((config?.tools ?? []).map((tool) => [tool.name, tool]));
  if (definitions.size === 0) return undefined;

  const shellTools: CursorSidecarShellTool[] = [];
  for (const kind of CURSOR_SHELL_TOOL_NAMES) {
    const definition = definitions.get(kind);
    if (!definition) continue;

    const savedSettings = config?.toolSettings?.[kind];
    if (savedSettings?.enabled === false) continue;

    const executable = findShellExecutable(kind);
    if (!executable) continue;

    const settings = normalizeShellToolSettings(savedSettings?.parameters ?? {});
    shellTools.push({
      kind,
      executable,
      description: definition.description,
      inputSchema: definition.parameters,
      timeoutMs: settings.timeoutMs,
      maxOutputBytes: settings.maxOutputBytes,
    });
  }

  return shellTools.length > 0 ? shellTools : undefined;
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
  config: TextGenerationRequest['generationConfig']
): Array<{ id: string; value: string }> | undefined {
  if (!config?.thinkingEnabled) return undefined;
  if (!config.reasoningEffort || !isCursorThinkingEffort(config.reasoningEffort)) return undefined;
  // Medium maps to the SDK default — only low/high are sent as explicit params.
  if (config.reasoningEffort === 'medium') return undefined;
  return [{ id: 'thinking', value: config.reasoningEffort }];
}

const lifecycle = createProviderLifecycle<PreparedCursorRuntime>({
  provider: 'cursor',
  loadPreparedRuntime,
  invalidateCachedModels: listModelsWithCache.invalidate,
  syncConfigFileConnectors: secretService.syncConfigFileConnectors,
});

async function runCursorGeneration(req: TextGenerationRequest): Promise<string> {
  const { apiKey, workspaceDir } = await lifecycle.prepareRuntime(req.userId, req.modelName);
  const prompt = buildCursorAgentPrompt({
    systemPrompt: req.systemPrompt,
    history: req.history,
    prompt: req.prompt,
  });

  let text = '';
  for await (const chunk of streamCursorAgentSidecar(
    {
      apiKey,
      model: req.modelName,
      cwd: workspaceDir,
      prompt,
      params: buildCursorModelParams(req.generationConfig),
      shellTools: buildCursorShellTools(req.generationConfig),
    },
    req.signal
  )) {
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
    const prompt = buildCursorAgentPrompt({
      systemPrompt: req.systemPrompt,
      history: req.history,
      prompt: req.prompt,
    });

    for await (const chunk of streamCursorAgentSidecar(
      {
        apiKey,
        model: req.modelName,
        cwd: workspaceDir,
        prompt,
        params: buildCursorModelParams(req.generationConfig),
        shellTools: buildCursorShellTools(req.generationConfig),
      },
      req.signal
    )) {
      if (req.signal?.aborted) break;
      yield chunk;
      // The sidecar stream always emits exactly one terminal chunk (error or a
      // final empty text chunk); forward it and stop instead of appending a
      // second terminal of our own.
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
