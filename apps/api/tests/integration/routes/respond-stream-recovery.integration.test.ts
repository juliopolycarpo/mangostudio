import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TurnCheckpointPartSchema } from '@mangostudio/shared/turn-recovery';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { createTurnCheckpointPart } from '../../../src/modules/generation/application/turn-checkpoint';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { insertMessage } from '../../../src/modules/messages/infrastructure/message-repository';
import {
  getProvider,
  invalidateProviderRoutingCache,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../src/services/providers/types';
import {
  insertTestChat,
  insertTestConnector,
  insertTestUser,
  type UserFixture,
} from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { buildRespondStreamRequest } from './_respond-stream-helpers';

const MODEL_ID = 'recovery-prompt-fit-model';

class RecoveryPromptProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly requests: AgentTurnRequest[] = [];

  generateText(): ReturnType<AIProvider['generateText']> {
    return Promise.resolve({ text: '' });
  }

  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }

  validateApiKey(): Promise<void> {
    return Promise.resolve();
  }

  resolveApiKey(): Promise<string> {
    return Promise.resolve('test-key');
  }

  async *generateAgentTurnStream(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.requests.push(request);
    yield { type: 'assistant_text_delta', text: 'Recovered.' };
    yield { type: 'turn_completed' };
  }
}

let user: UserFixture;
let chatId = '';
let provider: RecoveryPromptProvider;
let previousProvider: AIProvider;
let restoreAuth: (() => void) | null = null;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'];

beforeEach(async () => {
  previousProvider = getProvider('openai-compatible');
  provider = new RecoveryPromptProvider();
  registerProvider(provider);
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  await insertTestConnector(user.id, {
    id: `${user.id}-recovery-prompt-fit`,
    name: 'Recovery Prompt Fit Test Connector',
    enabledModels: [MODEL_ID],
  });
  invalidateProviderRoutingCache(user.id);
  const authenticated = createAuthenticatedApiTestApp(user, respondStreamRoutes);
  app = authenticated.app;
  restoreAuth = authenticated.restore;
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  registerProvider(previousProvider);
  invalidateProviderRoutingCache(user.id);
});

describe('POST /respond/stream — recovery prompt fitting', () => {
  it('resumes a schema-valid checkpoint with maximum-length incomplete call IDs', async () => {
    const messageId = crypto.randomUUID();
    const checkpoint = createTurnCheckpointPart({
      turnId: messageId,
      startedAt: Date.now(),
      provider: 'openai-compatible',
      modelName: MODEL_ID,
      agentId: 'default',
    });
    checkpoint.status = 'interrupted';
    checkpoint.reasonCode = 'server_restart';
    checkpoint.incompleteCalls = Array.from({ length: 50 }, (_, index) => ({
      callId: `call-${index}-`.padEnd(256, String(index % 10)).slice(0, 256),
      name: 'read_file',
      retrySafety: 'safe_read' as const,
      status: 'cancelled' as const,
      outcome: 'interrupted' as const,
    }));
    expect(Value.Check(TurnCheckpointPartSchema, checkpoint)).toBe(true);
    await insertMessage(
      {
        id: messageId,
        chatId,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: false,
        interactionMode: 'chat',
        modelName: MODEL_ID,
        parts: JSON.stringify([checkpoint]),
      },
      getDb()
    );

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId,
        prompt: 'Resume the interrupted work.',
        model: MODEL_ID,
        recovery: {
          messageId,
          requestId: crypto.randomUUID(),
          retryCallIds: [],
        },
      })
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(provider.requests).toHaveLength(1);
    const recoveryPrompt = provider.requests[0]?.prompt ?? '';
    expect(recoveryPrompt.length).toBeLessThanOrEqual(16_000);
    expect(recoveryPrompt).toContain('"omittedIncompleteCallCount":50');
  });
});
