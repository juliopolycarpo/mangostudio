import { describe, expect, it } from 'bun:test';
import {
  CURSOR_TOOL_BUDGET_EXHAUSTED_MESSAGE,
  createBudgetedToolExecutor,
  createCursorAgentTurnMappingState,
  flushOutstandingToolResults,
  mapCursorChunkToAgentEvents,
} from '../../../../../src/services/providers/cursor/agent-turn';
import type { StreamingChunk } from '../../../../../src/services/providers/types';

function chunk(partial: Partial<StreamingChunk> & Pick<StreamingChunk, 'type'>): StreamingChunk {
  return { done: false, ...partial };
}

describe('mapCursorChunkToAgentEvents', () => {
  it('maps thinking chunks to reasoning deltas', () => {
    const state = createCursorAgentTurnMappingState();
    expect(mapCursorChunkToAgentEvents(chunk({ type: 'thinking', text: 'hmm' }), state)).toEqual([
      { type: 'reasoning_delta', text: 'hmm' },
    ]);
    expect(mapCursorChunkToAgentEvents(chunk({ type: 'thinking', text: '' }), state)).toEqual([]);
  });

  it('maps text chunks to assistant deltas and drops the terminal marker', () => {
    const state = createCursorAgentTurnMappingState();
    expect(mapCursorChunkToAgentEvents(chunk({ type: 'text', text: 'Hi' }), state)).toEqual([
      { type: 'assistant_text_delta', text: 'Hi' },
    ]);
    expect(
      mapCursorChunkToAgentEvents(chunk({ type: 'text', text: '', done: true }), state)
    ).toEqual([]);
  });

  it('maps a custom tool call to started+completed and tracks it as outstanding', () => {
    const state = createCursorAgentTurnMappingState();
    const events = mapCursorChunkToAgentEvents(
      chunk({ type: 'tool_call', toolCallId: 'mango-tool-1', name: 'bash', args: { cmd: 'ls' } }),
      state
    );

    expect(events).toEqual([
      { type: 'tool_call_started', callId: 'mango-tool-1', name: 'bash' },
      {
        type: 'tool_call_completed',
        callId: 'mango-tool-1',
        name: 'bash',
        arguments: JSON.stringify({ cmd: 'ls' }),
      },
    ]);
    expect(state.outstandingCalls.get('mango-tool-1')).toBe('bash');
  });

  it('emits a synthetic tool_result for built-in tool calls with inline results', () => {
    const state = createCursorAgentTurnMappingState();
    const events = mapCursorChunkToAgentEvents(
      chunk({ type: 'tool_call', toolCallId: 'call-1', name: 'read_file', content: 'file body' }),
      state
    );

    expect(events).toHaveLength(3);
    expect(events[2]).toEqual({
      type: 'tool_result',
      callId: 'call-1',
      name: 'read_file',
      result: 'file body',
      isError: false,
    });
    expect(state.outstandingCalls.size).toBe(0);
  });

  it('generates a synthetic callId when the sidecar omits one', () => {
    const state = createCursorAgentTurnMappingState();
    const [first] = mapCursorChunkToAgentEvents(chunk({ type: 'tool_call', name: 'grep' }), state);
    const [second] = mapCursorChunkToAgentEvents(chunk({ type: 'tool_call' }), state);

    expect(first).toEqual({ type: 'tool_call_started', callId: 'cursor-call-1', name: 'grep' });
    expect(second).toEqual({ type: 'tool_call_started', callId: 'cursor-call-2', name: 'tool' });
  });

  it('resolves outstanding calls with tool_result chunks', () => {
    const state = createCursorAgentTurnMappingState();
    mapCursorChunkToAgentEvents(
      chunk({ type: 'tool_call', toolCallId: 'mango-tool-1', name: 'bash', args: {} }),
      state
    );

    const events = mapCursorChunkToAgentEvents(
      chunk({ type: 'tool_result', toolCallId: 'mango-tool-1', content: 'ok', isError: false }),
      state
    );

    expect(events).toEqual([
      { type: 'tool_result', callId: 'mango-tool-1', name: 'bash', result: 'ok', isError: false },
    ]);
    expect(state.outstandingCalls.size).toBe(0);
  });

  it('propagates error results and ignores tool_result chunks without a callId', () => {
    const state = createCursorAgentTurnMappingState();
    expect(
      mapCursorChunkToAgentEvents(
        chunk({
          type: 'tool_result',
          toolCallId: 'x',
          name: 'bash',
          content: 'nope',
          isError: true,
        }),
        state
      )
    ).toEqual([{ type: 'tool_result', callId: 'x', name: 'bash', result: 'nope', isError: true }]);
    expect(
      mapCursorChunkToAgentEvents(chunk({ type: 'tool_result', content: 'ok' }), state)
    ).toEqual([]);
  });

  it('maps error chunks to turn_error', () => {
    const state = createCursorAgentTurnMappingState();
    expect(
      mapCursorChunkToAgentEvents(chunk({ type: 'error', content: 'boom', done: true }), state)
    ).toEqual([{ type: 'turn_error', error: 'boom' }]);
    expect(mapCursorChunkToAgentEvents(chunk({ type: 'error', done: true }), state)).toEqual([
      { type: 'turn_error', error: 'Cursor agent run failed.' },
    ]);
  });
});

describe('flushOutstandingToolResults', () => {
  it('synthesizes error results for unresolved calls and clears the state', () => {
    const state = createCursorAgentTurnMappingState();
    mapCursorChunkToAgentEvents(
      chunk({ type: 'tool_call', toolCallId: 'mango-tool-1', name: 'bash', args: {} }),
      state
    );

    const events = flushOutstandingToolResults(state);
    expect(events).toEqual([
      {
        type: 'tool_result',
        callId: 'mango-tool-1',
        name: 'bash',
        result: 'The Cursor agent did not report a result for this call.',
        isError: true,
      },
    ]);
    expect(state.outstandingCalls.size).toBe(0);
    expect(flushOutstandingToolResults(state)).toEqual([]);
  });
});

describe('createBudgetedToolExecutor', () => {
  it('delegates execution while within budget', async () => {
    const calls: string[] = [];
    const executor = createBudgetedToolExecutor({
      maxToolCalls: 2,
      execute: (name) => {
        calls.push(name);
        return Promise.resolve({ result: 'ok' });
      },
      onExhausted: () => {
        throw new Error('should not exhaust');
      },
    });

    expect(await executor.execute('bash', {})).toEqual({ result: 'ok' });
    expect(await executor.execute('grep', {})).toEqual({ result: 'ok' });
    expect(calls).toEqual(['bash', 'grep']);
    expect(executor.isExhausted()).toBe(false);
  });

  it('returns error results past the cap and fires onExhausted exactly once', async () => {
    let exhaustedCount = 0;
    const executor = createBudgetedToolExecutor({
      maxToolCalls: 1,
      execute: () => Promise.resolve({ result: 'ok' }),
      onExhausted: () => {
        exhaustedCount += 1;
      },
    });

    await executor.execute('bash', {});
    expect(await executor.execute('bash', {})).toEqual({
      error: CURSOR_TOOL_BUDGET_EXHAUSTED_MESSAGE,
      isError: true,
    });
    expect(await executor.execute('bash', {})).toMatchObject({ isError: true });
    expect(exhaustedCount).toBe(1);
    expect(executor.isExhausted()).toBe(true);
  });
});
