/**
 * The relative-time helper, and the formatter cache behind it.
 *
 * The cache is not an optimization nobody can observe: the command palette maps
 * every chat in the account through here before its overlay paints, so the
 * construction count per locale is the thing worth pinning down.
 */

import { describe, expect, it } from 'bun:test';
import { formatMessage, formatRelativeTime } from '@/lib/i18n-format';

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Counts constructions while `run` executes, then puts `Intl` back. */
function countFormatters(run: () => void): number {
  const original = Intl.RelativeTimeFormat;
  let constructed = 0;
  class Counting extends original {
    constructor(locale?: Intl.LocalesArgument, options?: Intl.RelativeTimeFormatOptions) {
      super(locale, options);
      constructed += 1;
    }
  }
  (Intl as { RelativeTimeFormat: typeof Intl.RelativeTimeFormat }).RelativeTimeFormat = Counting;
  try {
    run();
  } finally {
    (Intl as { RelativeTimeFormat: typeof Intl.RelativeTimeFormat }).RelativeTimeFormat = original;
  }
  return constructed;
}

describe('formatMessage', () => {
  it('substitutes named placeholders and leaves unknown ones readable', () => {
    expect(formatMessage('New chat with {runner}', { runner: 'codex' })).toBe(
      'New chat with codex'
    );
    expect(formatMessage('New chat with {runner}')).toBe('New chat with {runner}');
  });
});

describe('formatRelativeTime', () => {
  it('picks the largest unit that fits', () => {
    expect(formatRelativeTime(NOW - 2 * DAY, 'en', NOW)).toBe('2 days ago');
    expect(formatRelativeTime(NOW - 5 * MINUTE, 'en', NOW)).toBe('5 minutes ago');
    expect(formatRelativeTime(NOW, 'en', NOW)).toBe('now');
  });

  it('constructs one formatter per locale, however many rows go through it', () => {
    // Locales nothing else in the suite touches, so the shared cache cannot
    // make this vacuous by already holding an entry.
    const constructed = countFormatters(() => {
      for (let index = 0; index < 20; index += 1) {
        formatRelativeTime(NOW - index * DAY, 'en-AU', NOW);
      }
    });

    expect(constructed).toBe(1);
  });

  it('keeps a separate formatter per locale', () => {
    const constructed = countFormatters(() => {
      formatRelativeTime(NOW - DAY, 'en-NZ', NOW);
      formatRelativeTime(NOW - DAY, 'en-IE', NOW);
    });

    expect(constructed).toBe(2);
    expect(formatRelativeTime(NOW - 5 * MINUTE, 'pt-BR', NOW)).toBe('há 5 minutos');
  });
});
