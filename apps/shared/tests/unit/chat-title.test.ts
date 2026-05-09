import { describe, expect, it } from 'vitest';
import {
  clampChatTitlePromptLength,
  createPromptChatTitle,
  createTimestampChatTitle,
  isTimestampChatTitle,
  sanitizeGeneratedChatTitle,
} from '../../src/chat';

describe('createTimestampChatTitle', () => {
  it('formats a new chat title with a readable local timestamp', () => {
    const date = new Date(2026, 4, 9, 7, 5);

    const title = createTimestampChatTitle(date);

    expect(title).toBe('New Chat [2026-05-09 07:05]');
  });
});

describe('isTimestampChatTitle', () => {
  it('matches only timestamp fallback titles', () => {
    expect(isTimestampChatTitle('New Chat [2026-05-09 07:05]')).toBe(true);
    expect(isTimestampChatTitle('New Chat')).toBe(false);
    expect(isTimestampChatTitle('User supplied title')).toBe(false);
  });
});

describe('createPromptChatTitle', () => {
  it('normalizes whitespace and truncates to the configured length', () => {
    const title = createPromptChatTitle('  Explain   deterministic testing with Vitest  ', 20);

    expect(title).toBe('Explain deterministi...');
  });

  it('returns null for blank prompts', () => {
    expect(createPromptChatTitle('   \n\t   ')).toBeNull();
  });
});

describe('clampChatTitlePromptLength', () => {
  it('keeps prompt title length inside the supported range', () => {
    expect(clampChatTitlePromptLength(1)).toBe(10);
    expect(clampChatTitlePromptLength(120)).toBe(80);
    expect(clampChatTitlePromptLength(Number.NaN)).toBe(30);
  });
});

describe('sanitizeGeneratedChatTitle', () => {
  it('removes common model formatting from generated titles', () => {
    expect(sanitizeGeneratedChatTitle('Title: "Deterministic Testing"', 'Fallback')).toBe(
      'Deterministic Testing'
    );
  });

  it('uses the prompt title fallback when the model returns no usable text', () => {
    expect(sanitizeGeneratedChatTitle('   ', 'Fallback Title')).toBe('Fallback Title');
  });
});
