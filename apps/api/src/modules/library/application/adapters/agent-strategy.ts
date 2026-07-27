import type { ResourceFormat, ResourceKind } from '@mangostudio/shared/library';
import { warmProviderForRequest } from '../../../../services/providers/core/provider-readiness';
import {
  getProvider,
  getProviderForModel,
} from '../../../../services/providers/core/provider-registry';
import { NoModelAvailableError, resolveModel } from '../../../generation/application/resolve-model';
import {
  buildLibraryAgentAdapterPrompt,
  LIBRARY_AGENT_ADAPTER_PROMPT_VERSION,
  LIBRARY_AGENT_ADAPTER_SYSTEM_PROMPT,
} from './agent-prompt';
import type { FormatAdapter } from './types';

export const AGENT_ADAPTER_MAX_INPUT_BYTES = 256 * 1024;
export const AGENT_ADAPTER_MAX_OUTPUT_BYTES = 512 * 1024;
export const AGENT_ADAPTER_TIMEOUT_MS = 30_000;
const AGENT_ADAPTER_MAX_OUTPUT_TOKENS = 16_384;

interface GenerateAgentDraftInput {
  readonly userId: string;
  readonly content: string;
  readonly to: ResourceFormat;
  readonly signal?: AbortSignal;
}

interface GenerateAgentDraftResult {
  readonly text: string;
  readonly modelId: string;
}

export interface AgentStrategyDeps {
  generate(input: GenerateAgentDraftInput): Promise<GenerateAgentDraftResult>;
  readonly timeoutMs: number;
}

export function createAgentStrategyAdapter(
  kind: ResourceKind,
  from: ResourceFormat,
  to: ResourceFormat,
  overrides: Partial<AgentStrategyDeps> = {}
): FormatAdapter {
  const deps: AgentStrategyDeps = {
    generate: generateConfiguredAgentDraft,
    timeoutMs: AGENT_ADAPTER_TIMEOUT_MS,
    ...overrides,
  };
  return {
    kind,
    from,
    to,
    strategy: 'agent',
    lossy: true,
    adapt: async (input) => {
      if (!input.userId) {
        return {
          ok: false,
          error: { code: 'model-unavailable', message: 'Agent adaptation requires a user.' },
        };
      }
      if (Buffer.byteLength(input.content, 'utf8') > AGENT_ADAPTER_MAX_INPUT_BYTES) {
        return {
          ok: false,
          error: {
            code: 'input-too-large',
            message: `Source exceeds the ${AGENT_ADAPTER_MAX_INPUT_BYTES}-byte agent adapter limit.`,
          },
        };
      }

      try {
        const timeoutSignal = AbortSignal.timeout(deps.timeoutMs);
        const signal = input.signal
          ? AbortSignal.any([input.signal, timeoutSignal])
          : timeoutSignal;
        const generated = await withAbort(
          deps.generate({
            userId: input.userId,
            content: input.content,
            to: input.to,
            signal,
          }),
          signal
        );
        if (Buffer.byteLength(generated.text, 'utf8') > AGENT_ADAPTER_MAX_OUTPUT_BYTES) {
          return {
            ok: false,
            error: {
              code: 'output-too-large',
              message: `Generated draft exceeds the ${AGENT_ADAPTER_MAX_OUTPUT_BYTES}-byte limit.`,
            },
          };
        }
        if (!generated.text.trim()) {
          return {
            ok: false,
            error: { code: 'empty-output', message: 'The model returned an empty draft.' },
          };
        }
        return {
          ok: true,
          content: generated.text,
          notes: [
            {
              code: 'semantic-rewrite',
              message: 'content was rewritten by a configured model and requires review',
            },
          ],
          requiresReview: true,
          lossy: true,
          provenance: {
            modelId: generated.modelId,
            promptVersion: LIBRARY_AGENT_ADAPTER_PROMPT_VERSION,
          },
        };
      } catch (error) {
        return { ok: false, error: classifyAgentAdapterFailure(error) };
      }
    },
  };
}

/** Curated client-facing codes/messages — never forward raw provider/connector text. */
function classifyAgentAdapterFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof NoModelAvailableError) {
    return {
      code: 'model-unavailable',
      message: 'No configured text model is available for agent adaptation.',
    };
  }
  const name = error instanceof DOMException || error instanceof Error ? error.name : undefined;
  if (name === 'TimeoutError') {
    return { code: 'adapter-timeout', message: 'Agent adaptation timed out.' };
  }
  if (name === 'AbortError') {
    return { code: 'adapter-cancelled', message: 'Agent adaptation was cancelled.' };
  }
  return {
    code: 'provider-failed',
    message: 'The model provider failed during agent adaptation.',
  };
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function generateConfiguredAgentDraft(
  input: GenerateAgentDraftInput
): Promise<GenerateAgentDraftResult> {
  const resolved = await resolveModel({ userId: input.userId, type: 'text' });
  const provider = resolved.providerType
    ? getProvider(resolved.providerType)
    : await getProviderForModel(resolved.modelId, input.userId);
  await warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: resolved.modelId,
    purpose: 'text',
  });
  const generated = await provider.generateText({
    userId: input.userId,
    history: [],
    prompt: buildLibraryAgentAdapterPrompt(input.content, input.to),
    systemPrompt: LIBRARY_AGENT_ADAPTER_SYSTEM_PROMPT,
    modelName: resolved.modelId,
    modelCapabilities: resolved.capabilities,
    signal: input.signal,
    generationConfig: {
      thinkingEnabled: false,
      reasoningEffort: 'low',
      maxOutputTokens: AGENT_ADAPTER_MAX_OUTPUT_TOKENS,
    },
  });
  return { text: generated.text, modelId: resolved.modelId };
}

export async function isAgentStrategyAvailable(userId: string): Promise<boolean> {
  try {
    await resolveModel({ userId, type: 'text' });
    return true;
  } catch {
    return false;
  }
}
