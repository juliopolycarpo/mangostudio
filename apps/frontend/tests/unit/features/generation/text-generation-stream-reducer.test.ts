import type { MessagePart } from '@mangostudio/shared';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import { describe, expect, it } from 'vitest';
import {
  createTextGenerationStreamState,
  reduceTextGenerationStreamChunk,
} from '../../../../src/features/generation/text-generation-stream-reducer';

const REDUCER_OPTIONS = { pendingSubagentName: 'Pending subagent' };

function reduceChunks(chunks: StreamChunk[]) {
  return chunks.reduce(
    (state, chunk) => reduceTextGenerationStreamChunk(state, chunk, REDUCER_OPTIONS),
    createTextGenerationStreamState({
      userMessageId: 'optimistic-user-1',
      aiMessageId: 'optimistic-ai-1',
    })
  );
}

function getPartsByType<TType extends MessagePart['type']>(parts: MessagePart[], type: TType) {
  return parts.filter((part): part is Extract<MessagePart, { type: TType }> => part.type === type);
}

describe('text generation stream reducer', () => {
  it('builds separate thinking segments across tool boundaries', () => {
    const state = reduceChunks([
      { type: 'thinking_start', done: false },
      { type: 'thinking', text: 'before tool', done: false },
      { type: 'tool_call_started', callId: 'tool-1', name: 'search', done: false },
      { type: 'thinking_start', done: false },
      { type: 'thinking', text: 'after tool', done: false },
      { type: 'text', text: 'answer', done: false },
    ]);

    expect(getPartsByType(state.parts, 'thinking')).toEqual([
      { type: 'thinking', text: 'before tool' },
      { type: 'thinking', text: 'after tool' },
    ]);
    expect(state.text).toBe('answer');
    expect(state.activeThinkingIndex).toBeNull();
  });

  it('updates tool call parts and tolerates malformed argument payloads', () => {
    const state = reduceChunks([
      { type: 'tool_call_started', callId: 'tool-1', name: 'search', done: false },
      {
        type: 'tool_call_completed',
        callId: 'tool-1',
        name: 'search',
        arguments: '{not-json',
        done: false,
      },
      {
        type: 'tool_result',
        callId: 'tool-1',
        result: { hits: 2 },
        isError: false,
        done: false,
      },
    ]);

    expect(state.parts).toEqual([
      { type: 'tool_call', toolCallId: 'tool-1', name: 'search', args: {} },
      {
        type: 'tool_result',
        toolCallId: 'tool-1',
        content: JSON.stringify({ hits: 2 }),
        isError: false,
      },
    ]);
  });

  it('upserts lifecycle snapshots onto existing tool call parts', () => {
    const queued = {
      status: 'queued',
      source: 'builtin',
      queuedAt: 1_000,
    } as const;
    const succeeded = {
      status: 'succeeded',
      source: 'builtin',
      queuedAt: 1_000,
      startedAt: 1_001,
      finishedAt: 1_400,
      durationMs: 399,
    } as const;
    const state = reduceChunks([
      { type: 'tool_call_started', callId: 'tool-1', name: 'search', done: false },
      {
        type: 'tool_call_completed',
        callId: 'tool-1',
        name: 'search',
        arguments: '{"q":"x"}',
        done: false,
      },
      { type: 'tool_execution', callId: 'tool-1', name: 'search', execution: queued, done: false },
      {
        type: 'tool_execution',
        callId: 'tool-1',
        name: 'search',
        execution: succeeded,
        done: false,
      },
    ]);

    const toolCalls = getPartsByType(state.parts, 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].execution).toEqual(succeeded);
  });

  it('creates a tool call part when a lifecycle transition arrives without start events', () => {
    const cancelled = {
      status: 'cancelled',
      source: 'mcp',
      queuedAt: 1_000,
      finishedAt: 1_050,
      reasonCode: 'user_cancelled',
    } as const;
    const state = reduceChunks([
      {
        type: 'tool_execution',
        callId: 'tool-9',
        name: 'mcp__demo__slow',
        execution: cancelled,
        done: false,
      },
    ]);

    expect(state.parts).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'tool-9',
        name: 'mcp__demo__slow',
        args: {},
        execution: cancelled,
      },
    ]);
  });

  it('upserts generated image parts as image events progress', () => {
    const state = reduceChunks([
      {
        type: 'image_generation_started',
        imageId: 'image-1',
        toolCallId: 'tool-1',
        prompt: 'cat portrait',
        done: false,
      },
      {
        type: 'image_generation_completed',
        imageId: 'image-1',
        toolCallId: 'tool-1',
        prompt: 'cat portrait',
        imageUrl: 'https://example.com/cat.png',
        modelName: 'flux',
        generationTime: '1.3s',
        done: false,
      },
      {
        type: 'image_generation_started',
        imageId: 'image-2',
        toolCallId: 'tool-2',
        prompt: 'dog portrait',
        done: false,
      },
      {
        type: 'image_generation_failed',
        imageId: 'image-2',
        toolCallId: 'tool-2',
        prompt: 'dog portrait',
        error: 'provider failed',
        modelName: 'flux',
        generationTime: '2.1s',
        done: false,
      },
    ]);

    expect(getPartsByType(state.parts, 'generated_image')).toEqual([
      {
        type: 'generated_image',
        imageId: 'image-1',
        toolCallId: 'tool-1',
        status: 'completed',
        prompt: 'cat portrait',
        imageUrl: 'https://example.com/cat.png',
        modelName: 'flux',
        generationTime: '1.3s',
      },
      {
        type: 'generated_image',
        imageId: 'image-2',
        toolCallId: 'tool-2',
        status: 'error',
        prompt: 'dog portrait',
        error: 'provider failed',
        modelName: 'flux',
        generationTime: '2.1s',
      },
    ]);
  });

  it('merges subagent system and lifecycle events into the trace part', () => {
    const state = reduceChunks([
      {
        type: 'system_event',
        event: 'subagent_response_attempt',
        detail: 'call=delegate-1 attempt=1',
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
        text: 'Found ',
        done: false,
      },
      { type: 'subagent_text', callId: 'delegate-1', agentId: 'explore', text: 'it.', done: false },
      {
        type: 'subagent_tool_call_started',
        callId: 'delegate-1',
        agentId: 'explore',
        toolCallId: 'tool-9',
        name: 'grep',
        done: false,
      },
      {
        type: 'subagent_completed',
        callId: 'delegate-1',
        agentId: 'explore',
        agentName: 'Explore',
        summary: 'Reducer isolated.',
        toolCallCount: 1,
        done: false,
      },
    ]);

    expect(getPartsByType(state.parts, 'subagent_trace')).toEqual([
      expect.objectContaining({
        toolCallId: 'delegate-1',
        agentId: 'explore',
        agentName: 'Explore',
        status: 'completed',
        summary: 'Reducer isolated.',
        toolCallCount: 1,
        lastMessage: 'Reducer isolated.',
        messages: [{ role: 'assistant', text: 'Found it.' }],
        tools: [{ callId: 'tool-9', name: 'grep' }],
        events: [{ event: 'response_attempt', attempt: 1, detail: 'call=delegate-1 attempt=1' }],
      }),
    ]);
  });

  it('reconciles server message ids and terminal done updates', () => {
    const state = reduceChunks([
      { type: 'user_message_id', messageId: 'server-user-1', done: false },
      { type: 'text', text: 'hello', done: false },
      { type: 'done', done: true, messageId: 'server-ai-1', generationTime: '0.8s' },
    ]);

    expect(state.currentUserMessageId).toBe('server-user-1');
    expect(state.currentAiMessageId).toBe('server-ai-1');
    expect(state.receivedServerUserMessageId).toBe(true);
    expect(state.receivedServerAiMessageId).toBe(true);
    expect(state.aiMessageUpdate).toEqual({
      targetMessageId: 'optimistic-ai-1',
      patch: {
        id: 'server-ai-1',
        isGenerating: false,
        text: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        generationTime: '0.8s',
      },
    });
  });

  it('adopts the durable assistant id before content arrives', () => {
    const state = reduceChunks([
      { type: 'assistant_message_id', messageId: 'server-ai-early', done: false },
    ]);

    expect(state.currentAiMessageId).toBe('server-ai-early');
    expect(state.receivedServerAiMessageId).toBe(true);
    expect(state.aiMessageUpdate).toEqual({
      targetMessageId: 'optimistic-ai-1',
      patch: { id: 'server-ai-early' },
    });
  });

  it('appends MCP media parts once, deduplicated by tool call and url', () => {
    const mediaChunk = {
      type: 'mcp_media',
      toolCallId: 'tool-1',
      serverSlug: 'charts',
      toolName: 'render',
      kind: 'image',
      mimeType: 'image/png',
      url: '/images/mcp-1.png',
      done: false,
    } as const;

    const state = reduceChunks([
      { type: 'tool_call_started', callId: 'tool-1', name: 'mcp__charts__render', done: false },
      mediaChunk,
      mediaChunk,
      {
        ...mediaChunk,
        kind: 'resource',
        mimeType: 'application/pdf',
        url: '/uploads/r.pdf',
        uri: 'file:///r.pdf',
      },
    ]);

    expect(getPartsByType(state.parts, 'mcp_media')).toEqual([
      {
        type: 'mcp_media',
        toolCallId: 'tool-1',
        serverSlug: 'charts',
        toolName: 'render',
        kind: 'image',
        mimeType: 'image/png',
        url: '/images/mcp-1.png',
      },
      {
        type: 'mcp_media',
        toolCallId: 'tool-1',
        serverSlug: 'charts',
        toolName: 'render',
        kind: 'resource',
        mimeType: 'application/pdf',
        url: '/uploads/r.pdf',
        uri: 'file:///r.pdf',
      },
    ]);
  });

  it('appends question parts once, deduplicated by tool call id', () => {
    const questionChunk: Extract<StreamChunk, { type: 'question' }> = {
      type: 'question',
      toolCallId: 'tool-1',
      questions: [
        {
          question: 'Which deploy target?',
          header: 'Deploy target',
          options: [{ label: 'Staging' }, { label: 'Production' }],
        },
      ],
      done: false,
    };

    const state = reduceChunks([
      { type: 'tool_call_started', callId: 'tool-1', name: 'ask_user_question', done: false },
      questionChunk,
      questionChunk,
    ]);

    expect(getPartsByType(state.parts, 'question')).toEqual([
      {
        type: 'question',
        toolCallId: 'tool-1',
        questions: questionChunk.questions,
      },
    ]);
    expect(state.aiMessageUpdate?.patch.parts).toContainEqual({
      type: 'question',
      toolCallId: 'tool-1',
      questions: questionChunk.questions,
    });
  });

  it('appends mcp elicitation parts once, deduplicated by elicitation id', () => {
    const elicitationChunk: Extract<StreamChunk, { type: 'mcp_elicitation_request' }> = {
      type: 'mcp_elicitation_request',
      elicitationId: 'elicit-1',
      toolCallId: 'tool-mcp',
      serverSlug: 'demo',
      message: 'Choose a tier',
      fields: [
        {
          name: 'tier',
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
    };

    const state = reduceChunks([
      { type: 'tool_call_started', callId: 'tool-mcp', name: 'mcp__demo__ask', done: false },
      elicitationChunk,
      elicitationChunk,
    ]);

    expect(getPartsByType(state.parts, 'mcp_elicitation')).toEqual([
      {
        type: 'mcp_elicitation',
        elicitationId: 'elicit-1',
        toolCallId: 'tool-mcp',
        serverSlug: 'demo',
        message: 'Choose a tier',
        fields: elicitationChunk.fields,
        status: 'pending',
      },
    ]);
  });

  it('moves an existing elicitation part to its first terminal status in place', () => {
    const requestChunk: Extract<StreamChunk, { type: 'mcp_elicitation_request' }> = {
      type: 'mcp_elicitation_request',
      elicitationId: 'elicit-1',
      toolCallId: 'tool-mcp',
      serverSlug: 'demo',
      message: 'Choose a tier',
      fields: [],
      status: 'pending',
      done: false,
    };
    const statusChunk: Extract<StreamChunk, { type: 'mcp_elicitation_status' }> = {
      type: 'mcp_elicitation_status',
      elicitationId: 'elicit-1',
      toolCallId: 'tool-mcp',
      status: 'cancelled',
      reason: 'tool_failed',
      done: false,
    };

    const state = reduceChunks([
      requestChunk,
      statusChunk,
      // Neither a late status nor a replayed pending request moves it back.
      { ...statusChunk, status: 'cancelled', reason: 'tool_finished' },
      requestChunk,
    ]);

    expect(getPartsByType(state.parts, 'mcp_elicitation')).toEqual([
      {
        type: 'mcp_elicitation',
        elicitationId: 'elicit-1',
        toolCallId: 'tool-mcp',
        serverSlug: 'demo',
        message: 'Choose a tier',
        fields: [],
        status: 'cancelled',
        reason: 'tool_failed',
      },
    ]);
    expect(state.aiMessageUpdate?.patch.parts).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation',
        status: 'cancelled',
        reason: 'tool_failed',
      })
    );
  });

  it('ignores a status event for an unknown elicitation id', () => {
    const state = reduceChunks([
      {
        type: 'mcp_elicitation_status',
        elicitationId: 'unknown',
        toolCallId: 'tool-mcp',
        status: 'cancelled',
        reason: 'turn_aborted',
        done: false,
      },
    ]);
    expect(getPartsByType(state.parts, 'mcp_elicitation')).toEqual([]);
  });

  it('appends todo parts once, deduplicated by tool call id', () => {
    const todoChunk: Extract<StreamChunk, { type: 'todo_update' }> = {
      type: 'todo_update',
      toolCallId: 'tool-1',
      todos: [
        { content: 'plan the work', status: 'completed' },
        { content: 'do the work', status: 'in_progress' },
      ],
      done: false,
    };

    const state = reduceChunks([
      { type: 'tool_call_started', callId: 'tool-1', name: 'todo_write', done: false },
      todoChunk,
      todoChunk,
    ]);

    expect(getPartsByType(state.parts, 'todo')).toEqual([
      {
        type: 'todo',
        toolCallId: 'tool-1',
        todos: todoChunk.todos,
      },
    ]);
    expect(state.aiMessageUpdate?.patch.parts).toContainEqual({
      type: 'todo',
      toolCallId: 'tool-1',
      todos: todoChunk.todos,
    });
  });

  it('appends a terminal error part without losing accumulated text', () => {
    const state = reduceChunks([
      { type: 'text', text: 'partial answer', done: false },
      { type: 'error', error: 'provider exploded', done: true },
    ]);

    expect(state.aiMessageUpdate).toEqual({
      targetMessageId: 'optimistic-ai-1',
      patch: {
        isGenerating: false,
        text: 'partial answer',
        parts: [
          { type: 'text', text: 'partial answer' },
          { type: 'error', text: 'provider exploded' },
        ],
      },
    });
  });
});
