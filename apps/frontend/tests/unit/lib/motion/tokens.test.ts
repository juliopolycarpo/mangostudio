/**
 * `src/lib/motion/tokens.ts` mirrors the motion custom properties in
 * `src/index.css`, because `motion` takes seconds and coefficient tuples where
 * CSS takes milliseconds and a `cubic-bezier()` string.
 *
 * Two things drift silently without this test: a duration retuned in CSS and
 * not in TS (so a panel animates at one speed and the hover on its trigger at
 * another), and the off-by-1000 of writing `200` where `motion` wanted `0.2` —
 * which reads as a frozen UI, not as a failing test.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DURATION_BASE,
  DURATION_QUICK,
  DURATION_SLOW,
  EASE_EMPHASIZED,
  EASE_STANDARD,
  type EaseTuple,
} from '@/lib/motion/tokens';

const STYLESHEET = readFileSync(join(import.meta.dir, '../../../../src/index.css'), 'utf8');

/** Seconds for the `--<name>: <n>ms` declaration, as `motion` wants it. */
function cssDurationSeconds(name: string): number {
  const match = STYLESHEET.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)ms`));
  if (!match?.[1]) throw new Error(`--${name} is not declared in index.css as a ms value`);
  return Number(match[1]) / 1000;
}

/** Coefficients of the `--<name>: cubic-bezier(a, b, c, d)` declaration. */
function cssEaseTuple(name: string): EaseTuple {
  const match = STYLESHEET.match(new RegExp(`--${name}:\\s*cubic-bezier\\(([^)]+)\\)`));
  if (!match?.[1]) throw new Error(`--${name} is not declared in index.css as a cubic-bezier`);
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  expect(parts).toHaveLength(4);
  return parts as EaseTuple;
}

describe('motion tokens', () => {
  it('mirrors every duration from index.css, converted to seconds', () => {
    expect(DURATION_QUICK).toBe(cssDurationSeconds('duration-quick'));
    expect(DURATION_BASE).toBe(cssDurationSeconds('duration-base'));
    expect(DURATION_SLOW).toBe(cssDurationSeconds('duration-slow'));
  });

  it('mirrors every easing from index.css as coefficients', () => {
    expect(EASE_STANDARD).toEqual(cssEaseTuple('ease-standard'));
    expect(EASE_EMPHASIZED).toEqual(cssEaseTuple('ease-emphasized'));
  });

  it('keeps durations in seconds, so a millisecond value cannot creep in', () => {
    // `motion` reads a bare number as seconds: 200 would be three and a half
    // minutes, and would look like a hang rather than a wrong duration.
    for (const duration of [DURATION_QUICK, DURATION_BASE, DURATION_SLOW]) {
      expect(duration).toBeLessThan(1);
      expect(duration).toBeGreaterThan(0);
    }
  });

  it('orders the durations quick < base < slow', () => {
    expect(DURATION_QUICK).toBeLessThan(DURATION_BASE);
    expect(DURATION_BASE).toBeLessThan(DURATION_SLOW);
  });
});
