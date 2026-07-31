import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitTopic, type RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';
import { getDb } from '../../../../src/db/database';
import { streamTextTurn } from '../../../../src/modules/generation/application/stream-text-turn';
import { resetGitRealtimeInvalidationsForTests } from '../../../../src/modules/git/application/git-realtime-service';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../../src/services/providers/types';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../../src/services/realtime/realtime-bus';
import { makeAgentProfile } from '../../../integration/routes/_respond-stream-helpers';
import { insertTestChat, insertTestUser, type UserFixture } from '../../../support/factories';

const RESOLVED_MODEL = {
  modelId: 'git-realtime-model',
  providerType: 'openai-compatible' as const,
  capabilities: { text: true, image: false, streaming: true, tools: true },
};

class ScriptedFileMutationProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  private iteration = 0;

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

  async *generateAgentTurnStream(_request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.iteration += 1;

    if (this.iteration === 1) {
      for (let index = 1; index <= 3; index += 1) {
        const callId = `create-${index}`;
        yield { type: 'tool_call_started', callId, name: 'create_file' };
        yield {
          type: 'tool_call_completed',
          callId,
          name: 'create_file',
          arguments: JSON.stringify({
            path: `file-${index}.txt`,
            content: `content ${index}\n`,
          }),
        };
      }
      yield { type: 'turn_completed' };
      return;
    }

    // Keep the turn open beyond the trailing debounce so the file-change event
    // arrives before the broader completion refresh.
    await Bun.sleep(650);
    yield { type: 'assistant_text_delta', text: 'Created three files.' };
    yield { type: 'turn_completed' };
  }
}

let previousProvider: AIProvider;
let user: UserFixture;
let chatId: string;
let workdir: string;
let realtimeEvents: RealtimeInvalidateEvent[];

beforeEach(async () => {
  previousProvider = getProvider('openai-compatible');
  registerProvider(new ScriptedFileMutationProvider());

  workdir = await mkdtemp(join(tmpdir(), 'mango-git-realtime-'));
  user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  chatId = chat.id;
  await getDb()
    .updateTable('chats')
    .set({ workdir, restrictToolsToWorkdir: 1 })
    .where('id', '=', chatId)
    .execute();

  realtimeEvents = [];
  const bus = createRealtimeBus();
  bus.subscribe(user.id, (event) => realtimeEvents.push(event));
  setRealtimeBusForTests(bus);
});

afterEach(async () => {
  resetGitRealtimeInvalidationsForTests();
  setRealtimeBusForTests(undefined);
  registerProvider(previousProvider);
  await rm(workdir, { recursive: true, force: true });
});

describe('Git realtime invalidation during generation', () => {
  it('coalesces a burst of file mutations and publishes a broader turn refresh', async () => {
    for await (const _event of streamTextTurn(
      {
        chatId,
        userId: user.id,
        prompt: 'Create three files.',
        agentMode: 'agent',
        resolvedModel: RESOLVED_MODEL,
        resolvedAgentProfile: makeAgentProfile({
          toolNames: ['create_file'],
          toolsEnabled: true,
          role: 'both',
        }),
      },
      getDb()
    )) {
      // Exhaust the stream so the tool loop and terminal invalidation complete.
    }

    expect(realtimeEvents.filter((event) => event.topic === gitTopic(chatId))).toEqual([
      {
        type: 'invalidate',
        topic: gitTopic(chatId),
        scopes: ['state', 'diffs'],
      },
      {
        type: 'invalidate',
        topic: gitTopic(chatId),
        scopes: ['state', 'diffs', 'history', 'github'],
      },
    ]);
    for (let index = 1; index <= 3; index += 1) {
      expect(await Bun.file(join(workdir, `file-${index}.txt`)).text()).toBe(`content ${index}\n`);
    }
  });
});
