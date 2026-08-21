import { describe, expect, it } from 'bun:test';
import type { McpPromptArgument } from '@mangostudio/shared/mcp';
import {
  flattenMcpPromptText,
  missingRequiredMcpArguments,
  serializeMcpPromptArguments,
} from '../../../../src/features/chat/lib/mcp-prompt-args';

const DESCRIPTORS: McpPromptArgument[] = [
  { name: 'topic', description: 'What to summarize.', required: true },
  { name: 'tone', required: false },
];

describe('serializeMcpPromptArguments', () => {
  it('trims values and drops empty or unknown entries', () => {
    const serialized = serializeMcpPromptArguments(DESCRIPTORS, {
      topic: '  mangoes  ',
      tone: '   ',
      unknown: 'ignored',
    });

    expect(serialized).toEqual({ topic: 'mangoes' });
  });

  it('returns undefined when nothing was provided, so no-arg prompts send no arguments', () => {
    expect(serializeMcpPromptArguments(DESCRIPTORS, {})).toBeUndefined();
    expect(serializeMcpPromptArguments([], {})).toBeUndefined();
  });
});

describe('missingRequiredMcpArguments', () => {
  it('reports required arguments that are empty or whitespace-only', () => {
    expect(missingRequiredMcpArguments(DESCRIPTORS, {})).toEqual(['topic']);
    expect(missingRequiredMcpArguments(DESCRIPTORS, { topic: '  ' })).toEqual(['topic']);
    expect(missingRequiredMcpArguments(DESCRIPTORS, { topic: 'mangoes' })).toEqual([]);
  });
});

describe('flattenMcpPromptText', () => {
  it('joins message texts with blank lines and skips empty entries', () => {
    const text = flattenMcpPromptText({
      messages: [
        { role: 'user', text: 'Summarize mangoes.' },
        { role: 'assistant', text: '' },
        { role: 'user', text: 'Keep it short.' },
      ],
    });

    expect(text).toBe('Summarize mangoes.\n\nKeep it short.');
  });
});
