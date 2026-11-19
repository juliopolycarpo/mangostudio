/**
 * A native chat turn that starts with `/name` expands the user's
 * `~/.mango/commands/name.md` into the prompt the model receives, while the
 * transcript keeps what the user typed. Only the model is faked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { streamTextTurn } from '../../../../src/modules/generation/application/stream-text-turn';
import { resetLibraryDiscoveryCache } from '../../../../src/modules/library/application/library-discovery';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../../src/services/providers/types';
import { makeAgentProfile } from '../../../integration/routes/_respond-stream-helpers';
import { insertTestChat, insertTestUser, type UserFixture } from '../../../support/factories';

const RESOLVED_MODEL = {
  modelId: 'native-command-model',
  providerType: 'openai-compatible' as const,
  capabilities: { text: true, image: false, streaming: true, tools: true },
};

/** Named fake: records every request and answers with one fixed reply. */
class RecordingProvider implements AIProvider {
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

  async *generateAgentTurnStream(req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.requests.push(req);
    yield { type: 'assistant_text_delta', text: 'ok' };
    yield { type: 'turn_completed' };
  }
}

let user: UserFixture;
let chatId: string;
let configHome: string;
let previousProvider: AIProvider | null = null;
let provider: RecordingProvider;

async function runTurn(prompt: string): Promise<void> {
  for await (const _event of streamTextTurn(
    {
      chatId,
      userId: user.id,
      prompt,
      resolvedModel: RESOLVED_MODEL,
      resolvedAgentProfile: makeAgentProfile({
        toolNames: ['*'],
        toolsEnabled: true,
        role: 'both',
      }),
    },
    getDb()
  )) {
    // Drained for its side effects: the provider records the request.
  }
}

beforeEach(async () => {
  configHome = mkdtempSync(join(tmpdir(), 'mango-native-command-turn-'));
  mkdirSync(join(configHome, 'commands'));
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    configFilePath: join(configHome, 'config.toml'),
  });
  resetLibraryDiscoveryCache();

  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;

  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  provider = new RecordingProvider();
  registerProvider(provider);
});

afterEach(() => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  rmSync(configHome, { recursive: true, force: true });
  resetLibraryDiscoveryCache();
});

describe('native slash command turn', () => {
  it('sends the expanded template to the model and stores what the user typed', async () => {
    writeFileSync(
      join(configHome, 'commands', 'review.md'),
      '---\ndescription: Review a file\n---\nReview $1 for bugs.\n',
      'utf8'
    );

    await runTurn('/review src/app.ts');

    expect(provider.requests[0]?.prompt).toBe('Review src/app.ts for bugs.');
    const stored = await getDb()
      .selectFrom('messages')
      .select('text')
      .where('chatId', '=', chatId)
      .where('role', '=', 'user')
      .execute();
    expect(stored.map((row) => row.text)).toEqual(['/review src/app.ts']);
  });

  it('sends an unknown command to the model verbatim', async () => {
    await runTurn('/nope src/app.ts');

    expect(provider.requests[0]?.prompt).toBe('/nope src/app.ts');
  });
});
