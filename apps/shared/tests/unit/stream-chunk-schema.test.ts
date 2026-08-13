import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';

import type { StreamChunk } from '../../src/streaming';
import { StreamChunkSchema } from '../../src/streaming';

const VALID_CHUNKS: StreamChunk[] = [
  { type: 'user_message_id', messageId: 'msg-user-1', done: false },
  { type: 'assistant_message_id', messageId: 'msg-ai-1', done: false },
  { type: 'thinking_start', done: false },
  { type: 'thinking', text: 'reasoning…', done: false },
  { type: 'text', text: 'Hello', done: false },
  { type: 'tool_call_started', callId: 'tool-1', name: 'search', done: false },
  {
    type: 'tool_call_completed',
    callId: 'tool-1',
    name: 'search',
    arguments: '{"q":"mangostudio"}',
    done: false,
  },
  {
    type: 'tool_result',
    callId: 'tool-1',
    result: { hits: 2 },
    isError: false,
    done: false,
  },
  {
    type: 'tool_execution',
    callId: 'tool-1',
    name: 'search',
    execution: {
      status: 'succeeded',
      source: 'builtin',
      queuedAt: 1_000,
      startedAt: 1_001,
      finishedAt: 1_500,
      durationMs: 499,
    },
    done: false,
  },
  {
    type: 'subagent_started',
    callId: 'delegate-1',
    agentId: 'explore',
    agentName: 'Explore',
    task: 'Inspect reducers.',
    done: false,
  },
  {
    type: 'subagent_text',
    callId: 'delegate-1',
    agentId: 'explore',
    text: 'Found the reducer.',
    done: false,
  },
  {
    type: 'subagent_tool_call_started',
    callId: 'delegate-1',
    agentId: 'explore',
    toolCallId: 'nested-1',
    name: 'read',
    done: false,
  },
  {
    type: 'subagent_completed',
    callId: 'delegate-1',
    agentId: 'explore',
    agentName: 'Explore',
    summary: 'Reducer looks correct.',
    toolCallCount: 1,
    done: false,
  },
  {
    type: 'subagent_failed',
    callId: 'delegate-2',
    agentId: 'explore',
    agentName: 'Explore',
    error: 'timed out',
    done: false,
  },
  {
    type: 'image_generation_started',
    imageId: 'image-1',
    toolCallId: 'tool-img',
    prompt: 'cat portrait',
    done: false,
  },
  {
    type: 'image_generation_completed',
    imageId: 'image-1',
    toolCallId: 'tool-img',
    prompt: 'cat portrait',
    imageUrl: 'https://example.com/cat.png',
    modelName: 'flux',
    generationTime: '1.3s',
    done: false,
  },
  {
    type: 'image_generation_failed',
    imageId: 'image-2',
    toolCallId: 'tool-img-2',
    prompt: 'dog portrait',
    error: 'provider failed',
    modelName: 'flux',
    generationTime: '2.1s',
    done: false,
  },
  {
    type: 'mcp_media',
    toolCallId: 'tool-mcp',
    serverSlug: 'files',
    toolName: 'read_resource',
    kind: 'image',
    mimeType: 'image/png',
    url: '/api/attachments/att-1',
    uri: 'file:///tmp/a.png',
    done: false,
  },
  {
    type: 'question',
    toolCallId: 'tool-q',
    questions: [
      {
        question: 'Which auth method?',
        header: 'Auth',
        options: [{ label: 'OAuth', description: 'Browser flow' }, { label: 'API key' }],
        allowMultiple: false,
      },
    ],
    done: false,
  },
  {
    type: 'mcp_elicitation_request',
    elicitationId: 'elicit-1',
    toolCallId: 'tool-mcp-elicit',
    serverSlug: 'demo',
    message: 'Choose a tier',
    fields: [
      {
        name: 'tier',
        title: 'Tier',
        required: true,
        kind: 'enum',
        options: [
          { value: 'free', label: 'Free' },
          { value: 'pro', label: 'Pro' },
        ],
      },
    ],
    status: 'pending',
    done: false,
  },
  {
    type: 'mcp_elicitation_status',
    elicitationId: 'elicit-1',
    toolCallId: 'tool-mcp-elicit',
    status: 'cancelled',
    reason: 'tool_failed',
    done: false,
  },
  {
    type: 'todo_update',
    toolCallId: 'tool-todo',
    todos: [
      { content: 'Ship schemas', status: 'in_progress' },
      { content: 'Open PR', status: 'pending' },
    ],
    done: false,
  },
  {
    type: 'context_info',
    estimatedInputTokens: 1200,
    contextLimit: 128_000,
    estimatedUsageRatio: 0.01,
    mode: 'stateful',
    severity: 'normal',
    done: false,
  },
  {
    type: 'fallback_notice',
    from: 'cursor',
    to: 'replay',
    reason: 'provider_changed',
    done: false,
  },
  {
    type: 'system_event',
    event: 'tool_loop_exhausted',
    detail: 'max iterations reached',
    done: false,
  },
  {
    type: 'continuation_transition',
    provider: 'openai',
    modelName: 'gpt-4.1',
    fromProvider: 'gemini',
    fromMode: 'stateful',
    toMode: 'replay',
    reasonCode: 'provider_changed',
    detail: 'switched provider',
    done: false,
  },
  { type: 'done', done: true, messageId: 'msg-ai-1', generationTime: '2.4s' },
  { type: 'error', error: 'generation failed', code: 'PROVIDER_ERROR', done: true },
];

describe('StreamChunkSchema', () => {
  it('accepts a representative valid payload for every chunk type', () => {
    const types = new Set(VALID_CHUNKS.map((chunk) => chunk.type));
    expect(types.size).toBe(VALID_CHUNKS.length);

    for (const chunk of VALID_CHUNKS) {
      expect(Value.Check(StreamChunkSchema, chunk), chunk.type).toBe(true);
    }
  });

  it('rejects mutated payloads that break required fields or discriminators', () => {
    const cases: Array<{ label: string; value: unknown }> = [
      {
        label: 'unknown type',
        value: { type: 'not_a_chunk', done: false },
      },
      {
        label: 'text missing text',
        value: { type: 'text', done: false },
      },
      {
        label: 'tool_call_started missing callId',
        value: { type: 'tool_call_started', name: 'search', done: false },
      },
      {
        label: 'tool_execution unknown status',
        value: {
          type: 'tool_execution',
          callId: 'tool-1',
          name: 'search',
          execution: { status: 'paused', source: 'builtin', queuedAt: 1_000 },
          done: false,
        },
      },
      {
        label: 'tool_execution unknown reason code',
        value: {
          type: 'tool_execution',
          callId: 'tool-1',
          name: 'search',
          execution: {
            status: 'failed',
            source: 'builtin',
            queuedAt: 1_000,
            reasonCode: 'because',
          },
          done: false,
        },
      },
      {
        label: 'done with done:false',
        value: { type: 'done', done: false, messageId: 'msg-1' },
      },
      {
        label: 'error with done:false',
        value: { type: 'error', error: 'boom', done: false },
      },
      {
        label: 'mcp_media invalid kind',
        value: {
          type: 'mcp_media',
          toolCallId: 't',
          serverSlug: 's',
          toolName: 'n',
          kind: 'video',
          mimeType: 'video/mp4',
          url: '/x',
          done: false,
        },
      },
      {
        label: 'question with empty options',
        value: {
          type: 'question',
          toolCallId: 't',
          questions: [{ question: 'Q?', options: [{ label: 'only-one' }] }],
          done: false,
        },
      },
      {
        label: 'mcp_elicitation_status non-terminal status',
        value: {
          type: 'mcp_elicitation_status',
          elicitationId: 'e',
          toolCallId: 't',
          status: 'pending',
          reason: 'responded',
          done: false,
        },
      },
      {
        label: 'mcp_elicitation_status unknown reason',
        value: {
          type: 'mcp_elicitation_status',
          elicitationId: 'e',
          toolCallId: 't',
          status: 'accepted',
          reason: 'because',
          done: false,
        },
      },
      {
        label: 'todo_update invalid status',
        value: {
          type: 'todo_update',
          toolCallId: 't',
          todos: [{ content: 'x', status: 'blocked' }],
          done: false,
        },
      },
      {
        label: 'continuation_transition bad reasonCode',
        value: {
          type: 'continuation_transition',
          provider: 'openai',
          modelName: 'gpt',
          fromMode: 'a',
          toMode: 'b',
          reasonCode: 'not_a_reason',
          done: false,
        },
      },
      {
        label: 'context_info bad severity',
        value: {
          type: 'context_info',
          estimatedInputTokens: 1,
          contextLimit: 2,
          estimatedUsageRatio: 0.5,
          mode: 'stateful',
          severity: 'extreme',
          done: false,
        },
      },
    ];

    for (const { label, value } of cases) {
      expect(Value.Check(StreamChunkSchema, value), label).toBe(false);
    }
  });
});
