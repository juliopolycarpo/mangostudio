import { describe, expect, test } from 'bun:test';

import {
  runPlainSubagentText,
  type SubagentTurnSession,
} from '../../../../src/modules/generation/application/subagent-turn-stages';
import {
  SUBAGENT_FAILED_CODE,
  SubagentDelegationError,
} from '../../../../src/modules/generation/application/subagent-turn-types';
import type { StreamingChunk } from '../../../../src/services/providers/types';

function createPlainTextSession(chunks: StreamingChunk[]): SubagentTurnSession {
  const signal = new AbortController().signal;

  return {
    input: { userId: 'user-subagent-stream', signal },
    resolvedModel: {
      modelId: 'cursor-model',
      capabilities: { text: true, image: false, streaming: true },
    },
    provider: {
      providerType: 'cursor',
      generateText: () => Promise.resolve({ text: '' }),
      generateTextStream: async function* () {
        await Promise.resolve();
        for (const chunk of chunks) yield chunk;
      },
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('cursor-key'),
    },
    runtime: { effectiveSystemPrompt: undefined, runtimeSettings: {} },
    toolDefinitions: [],
    allowedToolNames: new Set(),
    prompt: 'Summarize this task.',
    transcript: [],
    tools: [],
    summary: '',
  } as unknown as SubagentTurnSession;
}

describe('runPlainSubagentText', () => {
  test('throws provider error chunks instead of returning partial text', async () => {
    const session = createPlainTextSession([
      { type: 'text', text: 'partial', done: false },
      { type: 'error', content: 'Provider stream failed.', done: true },
    ]);

    let caught: unknown;
    try {
      await runPlainSubagentText(session);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SubagentDelegationError);
    expect((caught as SubagentDelegationError).message).toBe('Provider stream failed.');
    expect((caught as SubagentDelegationError).code).toBe(SUBAGENT_FAILED_CODE);
  });
});
