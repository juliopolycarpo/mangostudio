/**
 * Named fakes for "the provider rejects the connector's key".
 *
 * Each fake drives the adapter's real agent-turn stream function through the
 * vendor's real SDK client, with only the transport replaced by a fetch that
 * answers the way that vendor answers a revoked (401) or unauthorised (403) key.
 * The SDK therefore builds its own `APIError`, and the adapter's real error
 * handling decides what the caller sees. No key is real and nothing leaves the
 * process.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai/web';
import type { ProviderType } from '@mangostudio/shared/types';
import OpenAI from 'openai';

import { streamAnthropicAgentTurn } from '../../../src/services/providers/anthropic/stream';
import { streamDeepSeekAgentTurn } from '../../../src/services/providers/deepseek/agent-stream';
import { GEMINI_API_VERSION } from '../../../src/services/providers/gemini/client';
import { streamGeminiAgentTurn } from '../../../src/services/providers/gemini/interactions-stream';
import { streamOAICompatAgentTurn } from '../../../src/services/providers/openai-compatible/chat-completions-stream';
import { streamAgentTurnWithResponsesAPI } from '../../../src/services/providers/openai/responses-stream';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../src/services/providers/types';
import { FakeGeminiHttp } from './fake-gemini-http';

export type KeyRejectingProviderType = Extract<
  ProviderType,
  'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'openai-compatible'
>;

export const KEY_REJECTING_PROVIDER_TYPES: readonly KeyRejectingProviderType[] = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'openai-compatible',
];

/** Text every fake puts in its upstream error body; MangoStudio must not forward it. */
export const UPSTREAM_REJECTION_TEXT = 'Incorrect API key provided: sk-revoked-0000';

const FAKE_BASE_URL = 'https://provider.invalid/v1';
const FAKE_API_KEY = 'sk-revoked-0000';

type Wire = 'openai' | 'anthropic';

/** Answers every request with `status` and a vendor-shaped error body. */
class KeyRejectingHttp {
  readonly requestUrls: string[] = [];

  constructor(
    private readonly wire: Wire,
    private readonly status: number
  ) {}

  readonly fetch = (input: string | URL | Request): Promise<Response> => {
    this.requestUrls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(Response.json(this.body(), { status: this.status }));
  };

  private body(): unknown {
    if (this.wire === 'anthropic') {
      return {
        type: 'error',
        error: {
          type: this.status === 403 ? 'permission_error' : 'authentication_error',
          message: UPSTREAM_REJECTION_TEXT,
        },
      };
    }
    return {
      error: {
        message: UPSTREAM_REJECTION_TEXT,
        type: 'invalid_request_error',
        code: this.status === 403 ? 'permission_denied' : 'invalid_api_key',
      },
    };
  }
}

/** One provider whose key is rejected on every call. */
export class KeyRejectingProviderFake {
  private readonly http: KeyRejectingHttp | FakeGeminiHttp;

  constructor(
    readonly providerType: KeyRejectingProviderType,
    readonly status: number
  ) {
    if (providerType === 'gemini') {
      if (status !== 401 && status !== 403) {
        throw new RangeError(
          `(KeyRejectingProviderFake gemini): expected status 401 | 403 | received: ${status}`
        );
      }
      this.http = new FakeGeminiHttp(status === 401 ? 'unauthorized' : 'forbidden');
    } else {
      this.http = new KeyRejectingHttp(
        providerType === 'anthropic' ? 'anthropic' : 'openai',
        status
      );
    }
  }

  /** Requests the SDK actually sent, so a test can prove the fake was reached. */
  get requestCount(): number {
    return this.http instanceof FakeGeminiHttp
      ? this.http.requests.length
      : this.http.requestUrls.length;
  }

  /** The adapter's real agent-turn stream, over the vendor SDK pointed at this fake. */
  streamAgentTurn(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const http = this.http;
    switch (this.providerType) {
      case 'openai':
        return streamAgentTurnWithResponsesAPI(this.openAIClient(http as KeyRejectingHttp), req);
      case 'openai-compatible':
        return streamOAICompatAgentTurn(this.openAIClient(http as KeyRejectingHttp), req);
      case 'deepseek':
        return streamDeepSeekAgentTurn(this.openAIClient(http as KeyRejectingHttp), req);
      case 'anthropic':
        return streamAnthropicAgentTurn(
          new Anthropic({
            apiKey: FAKE_API_KEY,
            baseURL: FAKE_BASE_URL,
            fetch: (http as KeyRejectingHttp).fetch,
            maxRetries: 0,
          }),
          req
        );
      case 'gemini':
        return streamGeminiAgentTurn(
          req,
          new GoogleGenAI({
            apiKey: FAKE_API_KEY,
            apiVersion: GEMINI_API_VERSION,
            httpOptions: {
              baseUrl: 'https://gemini.invalid',
              fetch: (http as FakeGeminiHttp).fetch,
              retryOptions: { attempts: 1 },
            },
          })
        );
    }
  }

  /** The fake as a registrable provider, for tests that run a whole delegation. */
  asAIProvider(): AIProvider {
    return {
      providerType: this.providerType,
      generateText: () => Promise.resolve({ text: '' }),
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve(FAKE_API_KEY),
      generateAgentTurnStream: (req) => this.streamAgentTurn(req),
    };
  }

  private openAIClient(http: KeyRejectingHttp): OpenAI {
    return new OpenAI({
      apiKey: FAKE_API_KEY,
      baseURL: FAKE_BASE_URL,
      fetch: http.fetch,
      maxRetries: 0,
    });
  }
}
