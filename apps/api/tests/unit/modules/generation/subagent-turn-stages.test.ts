import { describe, expect, test } from 'bun:test';

import type { AgentEvent } from '@mangostudio/shared/types';

import {
  assembleSubagentResult,
  runPlainSubagentText,
  runSubagentStreamLoop,
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

/**
 * A provider whose agent stream replays one scripted event list per turn, in
 * order. The stream loop asks for another turn only when the previous one left
 * tool calls pending, so a script with a `tool_call_started` event continues
 * into the next list.
 */
function createScriptedAgentSession(turns: AgentEvent[][]): SubagentTurnSession {
  let turnIndex = 0;
  const session = createPlainTextSession([]);
  return {
    ...session,
    input: {
      ...session.input,
      chatId: 'chat-subagent-trace',
      environmentId: 'env-subagent-trace',
      request: { agentId: 'agent-subagent-trace', task: 'Think out loud.' },
      settings: { defaultMaxTurns: 4 },
    },
    runtime: {
      profile: { id: 'agent-subagent-trace', name: 'Tracer' },
      effectiveSystemPrompt: undefined,
      runtimeSettings: {},
      toolSettingsByName: new Map(),
    },
    provider: {
      ...session.provider,
      generateAgentTurnStream: async function* () {
        await Promise.resolve();
        for (const event of turns[turnIndex++] ?? []) yield event;
      },
    },
  } as unknown as SubagentTurnSession;
}

function reasoningDeltas(count: number): AgentEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'reasoning_delta' as const,
    text: `t${index} `,
  }));
}

describe('runSubagentStreamLoop reasoning transcript', () => {
  test('folds a run of reasoning deltas into one transcript entry', async () => {
    const deltaCount = 500;
    const session = createScriptedAgentSession([
      [...reasoningDeltas(deltaCount), { type: 'turn_completed' }],
    ]);

    await runSubagentStreamLoop(session);

    const expectedText = Array.from({ length: deltaCount }, (_, index) => `t${index} `).join('');
    expect(
      session.transcript,
      `(subagent transcript): expected 1 system entry after ${deltaCount} reasoning deltas | received ${session.transcript.length} entries`
    ).toEqual([{ role: 'system', text: expectedText }]);
  });

  test('assistant text between reasoning deltas starts a new entry', async () => {
    const session = createScriptedAgentSession([
      [
        { type: 'reasoning_delta', text: 'first ' },
        { type: 'reasoning_delta', text: 'thought' },
        { type: 'assistant_text_delta', text: 'answer' },
        { type: 'reasoning_delta', text: 'second ' },
        { type: 'reasoning_delta', text: 'thought' },
        { type: 'turn_completed' },
      ],
    ]);

    await runSubagentStreamLoop(session);

    expect(session.transcript).toEqual([
      { role: 'system', text: 'first thought' },
      { role: 'system', text: 'second thought' },
    ]);
  });

  test('a tool-call iteration between reasoning runs keeps them separate', async () => {
    const session = createScriptedAgentSession([
      [
        { type: 'reasoning_delta', text: 'plan ' },
        { type: 'reasoning_delta', text: 'a' },
        { type: 'tool_call_started', callId: 'call-1', name: 'tool_not_allowed' },
        {
          type: 'tool_call_completed',
          callId: 'call-1',
          name: 'tool_not_allowed',
          arguments: '{}',
        },
        { type: 'turn_completed' },
      ],
      [
        { type: 'reasoning_delta', text: 'plan ' },
        { type: 'reasoning_delta', text: 'b' },
        { type: 'turn_completed' },
      ],
    ]);

    await runSubagentStreamLoop(session);

    expect(session.transcript).toEqual([
      { role: 'system', text: 'plan a' },
      { role: 'system', text: 'plan b' },
    ]);
  });

  test('ignores empty reasoning deltas instead of opening an empty entry', async () => {
    const session = createScriptedAgentSession([
      [
        { type: 'reasoning_delta', text: '' },
        { type: 'reasoning_delta', text: 'real' },
        { type: 'turn_completed' },
      ],
    ]);

    await runSubagentStreamLoop(session);

    expect(session.transcript).toEqual([{ role: 'system', text: 'real' }]);
  });

  test('stored trace JSON tracks the reasoning text, not the delta count', async () => {
    // 500 short deltas. Before the fold this stored 501 entries, and every
    // entry added 28 bytes of `{"role":"system","text":""},` framing.
    const session = createScriptedAgentSession([
      [...reasoningDeltas(500), { type: 'turn_completed' }],
    ]);

    await runSubagentStreamLoop(session);
    const result = assembleSubagentResult(session, 1);
    const traceJsonBytes = JSON.stringify(result.trace).length;
    const reasoningText = session.transcript[0]?.text ?? '';

    expect(
      result.trace.messages.length,
      `(subagent trace): expected 2 entries (1 reasoning + 1 assistant) | received ${result.trace.messages.length}`
    ).toBe(2);
    // Fixed fields (agent, status, summary) cost a few hundred bytes; per-entry
    // framing is the only part that used to scale with the delta count.
    expect(
      traceJsonBytes,
      `(subagent trace): expected JSON under ${reasoningText.length + 500} bytes for ${reasoningText.length} reasoning characters | received ${traceJsonBytes}`
    ).toBeLessThan(reasoningText.length + 500);
  });

  test('the stored trace carries the folded entry and the closing assistant entry', async () => {
    const session = createScriptedAgentSession([
      [
        ...reasoningDeltas(50),
        { type: 'assistant_text_delta', text: 'All done.' },
        { type: 'turn_completed' },
      ],
    ]);

    await runSubagentStreamLoop(session);
    const result = assembleSubagentResult(session, 1);

    expect(result.trace.messages.map((message) => message.role)).toEqual(['system', 'assistant']);
    expect(result.trace.lastMessage).toBe('All done.');
  });
});
