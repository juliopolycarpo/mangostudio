/**
 * ChatGPT backend model catalog: static baseline + best-effort discovery.
 *
 * The static list is the source of truth for capabilities and the guaranteed
 * fallback — model availability differs by subscription plan and the backend's
 * discovery endpoint is not a stable contract, so discovery may improve the
 * list but must never break it.
 */

import { getConfig } from '../../../lib/config';
import type { ChatGptTokenBundle } from '../../../modules/connectors/infrastructure/chatgpt/oauth-client';
import { getModelContextLimit } from '../core/context-policy';
import { PROVIDER_PROBE_TIMEOUT_MS, withAbortTimeout } from '../core/probe-timeout';
import { recordProviderProbeTimeout } from '../core/provider-observability';
import type { ModelInfo } from '../types';
import { buildChatGptHeaders } from './client';

/**
 * Baseline ChatGPT-plan model set (verified against the Codex model lineup at
 * implementation time). Plan-dependent entries the account cannot serve are
 * rejected by the backend at request time.
 */
export const CHATGPT_STATIC_MODEL_IDS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const;

/**
 * Discovery is known to over-report plan-gated `*-pro` ids that the backend
 * then refuses to serve; drop them rather than surfacing broken entries.
 */
const UNSERVABLE_MODEL_ID_PATTERN = /-pro$/;

export function toChatGptModelInfo(modelId: string): ModelInfo {
  return {
    modelId,
    displayName: modelId,
    provider: 'chatgpt',
    inputTokenLimit: getModelContextLimit(modelId),
    capabilities: {
      text: true,
      image: false,
      streaming: true,
      reasoning: true,
      tools: true,
      statefulContinuation: false,
      promptCaching: false,
      parallelToolCalls: true,
      reasoningWithTools: true,
      // Revisit after probing the backend's json_schema support.
      structuredOutput: false,
      imageInput: true,
    },
  };
}

export function getChatGptStaticModels(): ModelInfo[] {
  return CHATGPT_STATIC_MODEL_IDS.map((modelId) => toChatGptModelInfo(modelId));
}

/** Auth failure (401/403) from the ChatGPT backend during a probe. */
export class ChatGptBackendAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('ChatGPT backend rejected the access token. Sign in with ChatGPT again to reconnect.');
    this.name = 'ChatGptBackendAuthError';
    this.status = status;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Fetches the backend model list. Tolerates both the OpenAI `{data: [{id}]}`
 * and the Codex `{models: [...]}` payload shapes.
 *
 * @throws {ChatGptBackendAuthError} on 401/403.
 * @throws {Error} on any other failure (callers fall back to the static list).
 */
export async function fetchChatGptModelIds(
  bundle: ChatGptTokenBundle,
  fetchImpl: FetchLike = fetch
): Promise<string[]> {
  const response = await withAbortTimeout(
    (signal) =>
      fetchImpl(`${getConfig().chatgpt.apiBaseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${bundle.accessToken}`,
          ...buildChatGptHeaders(bundle),
        },
        signal,
      }),
    'ChatGPT model discovery timed out.',
    PROVIDER_PROBE_TIMEOUT_MS,
    () =>
      recordProviderProbeTimeout({
        provider: 'chatgpt',
        operation: 'model-list',
        message: 'ChatGPT model discovery timed out.',
      })
  );

  if (response.status === 401 || response.status === 403) {
    throw new ChatGptBackendAuthError(response.status);
  }
  if (!response.ok) {
    throw new Error(`ChatGPT model discovery failed (HTTP ${response.status}).`);
  }

  const ids = parseModelIdsPayload(await response.json());
  return ids.filter((id) => !UNSERVABLE_MODEL_ID_PATTERN.test(id));
}

function parseModelIdsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry) {
      ids.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : item.slug;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Lists models for a token bundle: discovered ids when the endpoint answers,
 * otherwise the static baseline. Never throws for non-auth failures.
 */
export async function listChatGptModels(bundle: ChatGptTokenBundle): Promise<ModelInfo[]> {
  try {
    const ids = await fetchChatGptModelIds(bundle);
    if (ids.length > 0) return ids.map((modelId) => toChatGptModelInfo(modelId));
  } catch (err) {
    if (err instanceof ChatGptBackendAuthError) throw err;
    // Discovery is best-effort; the static baseline keeps listing total.
  }
  return getChatGptStaticModels();
}
