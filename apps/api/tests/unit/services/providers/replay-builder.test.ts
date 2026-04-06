import { describe, expect, it } from 'bun:test';
import {
  buildOpenAIResponsesReplay,
  buildGeminiInteractionsReplay,
  buildChatCompletionsReplay,
} from '../../../../src/services/providers/replay-builder';
import type { ChatTurnContext } from '../../../../src/services/providers/types';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function userTurn(id: string, text: string): ChatTurnContext {
  return { id, role: 'user', text };
}

function aiTurn(id: string, text: string, parts?: ChatTurnContext['parts']): ChatTurnContext {
  return { id, role: 'ai', text, parts };
}

/** Full agentic history: user → AI with tool_call → tool_result → assistant text */
const AGENTIC_HISTORY: ChatTurnContext[] = [
  userTurn('1', 'What is the weather in Paris?'),
  aiTurn('2', 'The weather in Paris is sunny and 22°C.', [
    { type: 'tool_call', toolCallId: 'call_1', name: 'get_weather', args: { city: 'Paris' } },
    { type: 'tool_result', toolCallId: 'call_1', content: '{"temp":22}', isError: false },
    { type: 'text', text: 'The weather in Paris is sunny and 22°C.' },
  ]),
];

/** History with no parts — backward-compatible plain-text replay */
const PLAIN_TEXT_HISTORY: ChatTurnContext[] = [userTurn('1', 'Hello'), aiTurn('2', 'Hi there!')];

/** Mixed history: first turn has parts, second does not */
const MIXED_HISTORY: ChatTurnContext[] = [
  userTurn('1', 'Run the tool'),
  aiTurn('2', 'Done.', [
    { type: 'tool_call', toolCallId: 'tc1', name: 'run_tool', args: {} },
    { type: 'tool_result', toolCallId: 'tc1', content: 'ok', isError: false },
    { type: 'text', text: 'Done.' },
  ]),
  userTurn('3', 'Thanks'),
  aiTurn('4', 'You are welcome!'),
];

/** History with thinking parts — thinking must be excluded from replay */
const THINKING_HISTORY: ChatTurnContext[] = [
  userTurn('1', "What's 2+2?"),
  aiTurn('2', '4', [
    { type: 'thinking', text: 'The user wants basic arithmetic.', redacted: false },
    { type: 'text', text: '4' },
  ]),
];

// ---------------------------------------------------------------------------
// buildOpenAIResponsesReplay
// ---------------------------------------------------------------------------

describe('buildOpenAIResponsesReplay', () => {
  it('returns empty array for empty history', () => {
    expect(buildOpenAIResponsesReplay([])).toEqual([]);
  });

  it('falls back to role+text when parts are absent', () => {
    const result = buildOpenAIResponsesReplay(PLAIN_TEXT_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('reconstructs tool_call and tool_result from agentic parts', () => {
    const result = buildOpenAIResponsesReplay(AGENTIC_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: 'What is the weather in Paris?' },
      { role: 'assistant', content: 'The weather in Paris is sunny and 22°C.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":22}' },
    ]);
  });

  it('handles mixed history (some turns have parts, some do not)', () => {
    const result = buildOpenAIResponsesReplay(MIXED_HISTORY);
    // Turn 2 has parts, turn 4 does not
    expect(result).toContainEqual({ role: 'user', content: 'Run the tool' });
    expect(result).toContainEqual({
      type: 'function_call',
      call_id: 'tc1',
      name: 'run_tool',
      arguments: '{}',
    });
    expect(result).toContainEqual({ type: 'function_call_output', call_id: 'tc1', output: 'ok' });
    expect(result).toContainEqual({ role: 'user', content: 'Thanks' });
    // Turn 4 falls back to plain text assistant message
    expect(result).toContainEqual({ role: 'assistant', content: 'You are welcome!' });
  });

  it('excludes thinking parts from replay output', () => {
    const result = buildOpenAIResponsesReplay(THINKING_HISTORY);
    // Only the text part should appear as assistant content
    expect(result).toEqual([
      { role: 'user', content: "What's 2+2?" },
      { role: 'assistant', content: '4' },
    ]);
    // No thinking content should appear
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('arithmetic');
  });
});

// ---------------------------------------------------------------------------
// buildGeminiInteractionsReplay
// ---------------------------------------------------------------------------

describe('buildGeminiInteractionsReplay', () => {
  it('returns empty array for empty history', () => {
    expect(buildGeminiInteractionsReplay([])).toEqual([]);
  });

  it('falls back to role+text when parts are absent', () => {
    const result = buildGeminiInteractionsReplay(PLAIN_TEXT_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'model', content: 'Hi there!' },
    ]);
  });

  it('reconstructs tool_call and tool_result from agentic parts', () => {
    const result = buildGeminiInteractionsReplay(AGENTIC_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: 'What is the weather in Paris?' },
      { role: 'model', content: 'The weather in Paris is sunny and 22°C.' },
      {
        role: 'model',
        content: [
          {
            type: 'function_call',
            id: 'call_1',
            name: 'get_weather',
            arguments: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'function_result',
            call_id: 'call_1',
            name: '',
            result: { temp: 22 },
            is_error: false,
          },
        ],
      },
    ]);
  });

  it('parses tool_result content as JSON when possible', () => {
    const history: ChatTurnContext[] = [
      aiTurn('1', '', [
        { type: 'tool_call', toolCallId: 'tc_x', name: 'fetch', args: {} },
        { type: 'tool_result', toolCallId: 'tc_x', content: '{"ok":true}', isError: false },
      ]),
    ];
    const result = buildGeminiInteractionsReplay(history);
    const resultTurn = result.find((t) => t.role === 'user' && Array.isArray(t.content));
    expect(resultTurn).toBeDefined();
    const contents = resultTurn?.content as Array<Record<string, unknown>>;
    expect(contents[0].result).toEqual({ ok: true });
  });

  it('keeps tool_result content as string when JSON.parse fails', () => {
    const history: ChatTurnContext[] = [
      aiTurn('1', '', [
        { type: 'tool_call', toolCallId: 'tc_y', name: 'cmd', args: {} },
        { type: 'tool_result', toolCallId: 'tc_y', content: 'plain text output', isError: false },
      ]),
    ];
    const result = buildGeminiInteractionsReplay(history);
    const resultTurn = result.find((t) => t.role === 'user' && Array.isArray(t.content));
    const contents = resultTurn?.content as Array<Record<string, unknown>>;
    expect(contents[0].result).toBe('plain text output');
  });

  it('handles mixed history (some turns have parts, some do not)', () => {
    const result = buildGeminiInteractionsReplay(MIXED_HISTORY);
    expect(result).toContainEqual({ role: 'user', content: 'Run the tool' });
    expect(result).toContainEqual({ role: 'user', content: 'Thanks' });
    // Fallback turn
    expect(result).toContainEqual({ role: 'model', content: 'You are welcome!' });
  });

  it('excludes thinking parts from replay output', () => {
    const result = buildGeminiInteractionsReplay(THINKING_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: "What's 2+2?" },
      { role: 'model', content: '4' },
    ]);
    expect(JSON.stringify(result)).not.toContain('arithmetic');
  });

  it('skips turns with empty text when no parts', () => {
    const history: ChatTurnContext[] = [
      userTurn('1', '  '), // whitespace only
      aiTurn('2', 'Hi'),
    ];
    const result = buildGeminiInteractionsReplay(history);
    // Whitespace-only user turn is skipped
    expect(result).not.toContainEqual(expect.objectContaining({ role: 'user' }));
    expect(result).toContainEqual({ role: 'model', content: 'Hi' });
  });
});

// ---------------------------------------------------------------------------
// buildChatCompletionsReplay
// ---------------------------------------------------------------------------

describe('buildChatCompletionsReplay', () => {
  it('returns empty array for empty history', () => {
    expect(buildChatCompletionsReplay([])).toEqual([]);
  });

  it('falls back to role+text when parts are absent', () => {
    const result = buildChatCompletionsReplay(PLAIN_TEXT_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('reconstructs tool_calls and tool result messages from agentic parts', () => {
    const result = buildChatCompletionsReplay(AGENTIC_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: 'What is the weather in Paris?' },
      {
        role: 'assistant',
        content: 'The weather in Paris is sunny and 22°C.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"temp":22}',
      },
    ]);
  });

  it('handles mixed history (some turns have parts, some do not)', () => {
    const result = buildChatCompletionsReplay(MIXED_HISTORY);
    // Turn with tool_calls
    const assistantWithTools = result.find((m) => m.role === 'assistant' && 'tool_calls' in m);
    expect(assistantWithTools).toBeDefined();
    // Fallback turn
    expect(result).toContainEqual({ role: 'assistant', content: 'You are welcome!' });
  });

  it('excludes thinking parts from replay output', () => {
    const result = buildChatCompletionsReplay(THINKING_HISTORY);
    expect(result).toEqual([
      { role: 'user', content: "What's 2+2?" },
      { role: 'assistant', content: '4' },
    ]);
    expect(JSON.stringify(result)).not.toContain('arithmetic');
  });

  it('sets content to null when AI turn has only tool_calls and no text', () => {
    const history: ChatTurnContext[] = [
      userTurn('1', 'Run command'),
      aiTurn('2', '', [
        { type: 'tool_call', toolCallId: 'tc_z', name: 'run', args: { cmd: 'ls' } },
        { type: 'tool_result', toolCallId: 'tc_z', content: 'file1.txt', isError: false },
      ]),
    ];
    const result = buildChatCompletionsReplay(history);
    const assistantMsg = result.find((m) => m.role === 'assistant' && 'tool_calls' in m) as
      | Record<string, unknown>
      | undefined;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBeNull();
  });
});
