import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig } from '../../../lib/config';
import { parseStringArray } from '../../../utils/json';
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
import { streamCursorAgentSidecar } from './agent-runner';
import { fetchCursorModels, validateCursorApiKey } from './client';
import { detectNodeRuntime } from './node-runtime';
import { buildCursorAgentPrompt } from './prompt-builder';

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

  for (const row of rows) {
    if (!row.configured) continue;
    const enabled = parseStringArray(row.enabledModels);
    if (modelName && !enabled.includes(modelName)) continue;
    const apiKey = await secretService.resolveSecretValue(row);
    if (!apiKey) continue;
    return { apiKey, workspaceDir: resolveCursorWorkspaceDir() };
  }

  throw new CursorConnectorError('No Cursor API key is configured for the requested model.');
}

function resolveCursorWorkspaceDir(): string {
  const configured = getConfig().cursor.workspaceDir.trim();
  return configured || process.cwd();
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
  const runtime = await detectNodeRuntime();
  if (!runtime.available) {
    throw new CursorConnectorError(runtime.reason ?? 'Node.js is required for Cursor SDK agents.');
  }

  const { apiKey, workspaceDir } = await resolveClientConfig(userId, modelName);
  return { apiKey, workspaceDir };
}

const lifecycle = createProviderLifecycle<PreparedCursorRuntime>({
  provider: 'cursor',
  loadPreparedRuntime,
  invalidateCachedModels: listModelsWithCache.invalidate,
  syncConfigFileConnectors: secretService.syncConfigFileConnectors,
});

async function runCursorGeneration(
  req: TextGenerationRequest,
  onChunk?: (chunk: StreamingChunk) => void
): Promise<string> {
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
    },
    req.signal
  )) {
    if (chunk.type === 'error') {
      throw new CursorConnectorError(chunk.content ?? 'Cursor agent run failed.');
    }
    if (chunk.type === 'text' && chunk.text) {
      text += chunk.text;
    }
    onChunk?.(chunk);
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

    let sawTerminal = false;

    for await (const chunk of streamCursorAgentSidecar(
      {
        apiKey,
        model: req.modelName,
        cwd: workspaceDir,
        prompt,
      },
      req.signal
    )) {
      if (req.signal?.aborted) break;
      if (chunk.type === 'error') {
        sawTerminal = true;
        yield chunk;
        return;
      }
      yield chunk;
    }

    if (!sawTerminal) {
      yield { type: 'text', text: '', done: true };
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
      throw new Error('cursor healthcheck requires an API key.');
    }

    const runtime = await detectNodeRuntime();
    if (!runtime.available) {
      throw new Error(runtime.reason ?? 'Node.js is required for Cursor SDK agents.');
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

export { cursorProvider };
