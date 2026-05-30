import { describe, expect, it } from 'bun:test';
import { formatUptime } from '../../../src/cli/format';

describe('formatUptime', () => {
  it('formats seconds only', () => {
    expect(formatUptime(45_000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatUptime(125_000)).toBe('2m 5s');
  });

  it('formats hours, minutes and seconds', () => {
    expect(formatUptime(3_661_000)).toBe('1h 1m 1s');
  });

  it('clamps negative durations to 0s', () => {
    expect(formatUptime(-1000)).toBe('0s');
  });
});
