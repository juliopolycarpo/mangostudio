import { describe, expect, it } from 'bun:test';

import {
  clampChatTitlePromptLength,
  createPromptChatTitle,
  createTimestampChatTitle,
  isTimestampChatTitle,
  sanitizeGeneratedChatTitle,
} from '../../src/chat';

describe('createTimestampChatTitle', () => {
  it('formats a new chat title with a readable local timestamp', () => {
    const enteredAt = performance.now();
    const initialProcessCpu = process.cpuUsage();
    let dateConstructedMs: number | null = null;
    let titleCreatedMs: number | null = null;
    let assertionCompletedMs: number | null = null;

    try {
      const date = new Date(2026, 4, 9, 7, 5);
      dateConstructedMs = performance.now() - enteredAt;

      const title = createTimestampChatTitle(date);
      titleCreatedMs = performance.now() - enteredAt;

      expect(title).toBe('New Chat [2026-05-09 07:05]');
      assertionCompletedMs = performance.now() - enteredAt;
    } finally {
      const callbackWallMs = performance.now() - enteredAt;
      const wholeProcessCpuMicros = process.cpuUsage(initialProcessCpu);
      // eslint-disable-next-line no-console -- Retain phases when the runner times out after callback return.
      console.info(
        '[timestamp-title-case]',
        JSON.stringify({
          pid: process.pid,
          entryMonotonicMs: enteredAt,
          phaseElapsedMs: { dateConstructedMs, titleCreatedMs, assertionCompletedMs },
          callbackWallMs,
          wholeProcessCpuMicros,
        })
      );
    }
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

  it('strips single, double, and backtick wrapping quotes', () => {
    expect(sanitizeGeneratedChatTitle("'Single Quoted'", 'Fallback')).toBe('Single Quoted');
    expect(sanitizeGeneratedChatTitle('`Backtick Quoted`', 'Fallback')).toBe('Backtick Quoted');
  });

  it('uses the prompt title fallback when the model returns no usable text', () => {
    expect(sanitizeGeneratedChatTitle('   ', 'Fallback Title')).toBe('Fallback Title');
  });

  it('strips long runs of wrapping quotes', () => {
    const wrapped = `${'"'.repeat(50_000)}Title${'`'.repeat(50_000)}`;

    expect(sanitizeGeneratedChatTitle(wrapped, 'Fallback')).toBe('Title');
  });

  it('handles an interior run of quotes without catastrophic backtracking', () => {
    // The replaced `/^["'`]+|["'`]+$/g` cleanup takes seconds on this shape; the linear trim
    // takes about a millisecond, so the budget only has to separate those two.
    const hostile = `x${'"'.repeat(50_000)}x`;

    const start = performance.now();
    const result = sanitizeGeneratedChatTitle(hostile, 'Fallback');

    expect(performance.now() - start).toBeLessThan(1_000);
    expect(result).toBe(`x${'"'.repeat(79)}...`);
  });

  it('falls back when the title is only quote characters', () => {
    expect(sanitizeGeneratedChatTitle('""""""', 'Fallback')).toBe('Fallback');
  });
});
