import { describe, expect, it } from 'bun:test';
import { createChatCompletionsAccumulator } from '../../../../src/services/providers/core/chat-completions-accumulator';

describe('createChatCompletionsAccumulator', () => {
  it('accumulates text, reasoning, and tool call events', () => {
    const accumulator = createChatCompletionsAccumulator({
      extractReasoningChunks: (delta) =>
        typeof delta.reasoning === 'string' && delta.reasoning ? [delta.reasoning] : [],
    });

    const events = [
      ...accumulator.addDelta({ reasoning: 'Think first', content: 'Answer' }),
      ...accumulator.addDelta({
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{' } }],
      }),
      ...accumulator.addDelta({
        tool_calls: [{ index: 0, function: { arguments: '"query":"cats"}' } }],
      }),
      ...accumulator.finishToolCalls(),
    ];

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'Think first' },
      { type: 'assistant_text_delta', text: 'Answer' },
      { type: 'tool_call_started', callId: 'call_1', name: 'search' },
      { type: 'tool_call_arguments_delta', callId: 'call_1', delta: '{' },
      { type: 'tool_call_arguments_delta', callId: 'call_1', delta: '"query":"cats"}' },
      {
        type: 'tool_call_completed',
        callId: 'call_1',
        name: 'search',
        arguments: '{"query":"cats"}',
      },
    ]);

    expect(accumulator.buildAssistantMessage()).toEqual({
      role: 'assistant',
      content: 'Answer',
      reasoning_content: 'Think first',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"query":"cats"}' },
        },
      ],
    });
  });

  it('omits reasoning_content when no tool calls were accumulated', () => {
    const accumulator = createChatCompletionsAccumulator({
      extractReasoningChunks: (delta) =>
        typeof delta.reasoning_content === 'string' && delta.reasoning_content
          ? [delta.reasoning_content]
          : [],
    });

    accumulator.addDelta({ reasoning_content: 'Private reasoning', content: 'Final answer' });

    expect(accumulator.buildAssistantMessage()).toEqual({
      role: 'assistant',
      content: 'Final answer',
    });
  });
});
