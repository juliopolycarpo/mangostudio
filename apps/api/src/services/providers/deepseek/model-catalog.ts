import type { ModelInfo } from '../types';
import { isReasoningModel } from '../core/capability-detector';
import { getModelContextLimit } from '../core/context-policy';
import { recordProviderProbeTimeout } from '../core/provider-observability';
import { withAbortTimeout } from '../core/probe-timeout';
import { normalizeDeepSeekBaseUrl } from './options';

const MODEL_LIST_TIMEOUT_MS = 5_000;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEEPSEEK_FALLBACK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
] as const;

interface DeepSeekModelListResponse {
  data?: Array<{ id?: string }>;
}

function isTextModel(modelId: string): boolean {
  return !modelId.includes('embedding') && !modelId.includes('tts') && !modelId.includes('whisper');
}

function hasToolSupport(modelId: string): boolean {
  return modelId === 'deepseek-v4-flash' || modelId === 'deepseek-v4-pro';
}

export function toDeepSeekModelInfo(modelId: string): ModelInfo {
  const text = isTextModel(modelId);
  const reasoning = isReasoningModel(modelId);
  const v4Tools = hasToolSupport(modelId);

  return {
    modelId,
    displayName: modelId,
    provider: 'deepseek',
    inputTokenLimit: getModelContextLimit(modelId),
    capabilities: {
      text,
      image: false,
      streaming: text,
      reasoning,
      tools: v4Tools,
      statefulContinuation: false,
      promptCaching: true,
      parallelToolCalls: false,
      reasoningWithTools: reasoning && v4Tools,
      structuredOutput: text,
    },
  };
}

export async function fetchDeepSeekModels(params: {
  apiKey: string;
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ModelInfo[]> {
  const fetchImpl = params.fetchImpl ?? fetch;

  return withAbortTimeout(
    async (abortSignal) => {
      const signal = params.signal ? AbortSignal.any([abortSignal, params.signal]) : abortSignal;

      const response = await fetchImpl(`${normalizeDeepSeekBaseUrl(params.baseUrl)}/models`, {
        headers: { Authorization: `Bearer ${params.apiKey}` },
        signal,
      });

      if (!response.ok) {
        throw new DeepSeekApiError(`DeepSeek model listing failed (HTTP ${response.status}).`);
      }

      const payload = (await response.json()) as DeepSeekModelListResponse;
      const modelIds = (payload.data ?? [])
        .map((model) => model.id)
        .filter((modelId): modelId is string => Boolean(modelId));

      return modelIds
        .map(toDeepSeekModelInfo)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    },
    'DeepSeek model listing timed out.',
    MODEL_LIST_TIMEOUT_MS,
    () =>
      recordProviderProbeTimeout({
        provider: 'deepseek',
        operation: 'model-list',
        message: 'DeepSeek model listing timed out.',
      })
  );
}

export function getDeepSeekFallbackModels(): ModelInfo[] {
  return DEEPSEEK_FALLBACK_MODELS.map(toDeepSeekModelInfo);
}

export class DeepSeekApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeepSeekApiError';
  }
}
