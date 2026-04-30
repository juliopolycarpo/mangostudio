import { describe, it, expect } from 'vitest';
import { cn, extractApiError } from '@/lib/utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    const falsy = false as const;
    expect(cn('base', falsy && 'hidden', 'visible')).toBe('base visible');
  });

  it('resolves tailwind conflicts', () => {
    expect(cn('px-4 py-2', 'px-2')).toBe('py-2 px-2');
  });

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });
});

describe('extractApiError', () => {
  it('returns the error field from an ApiErrorResponse object', () => {
    expect(extractApiError({ error: 'Something went wrong' })).toBe('Something went wrong');
  });

  it('returns a string value directly', () => {
    expect(extractApiError('Network error')).toBe('Network error');
  });

  it('returns empty string for empty string input', () => {
    expect(extractApiError('')).toBe('Unknown error');
  });

  it('returns fallback for null', () => {
    expect(extractApiError(null)).toBe('Unknown error');
  });

  it('returns fallback for undefined', () => {
    expect(extractApiError(undefined)).toBe('Unknown error');
  });

  it('returns fallback for object without error field', () => {
    expect(extractApiError({ status: 500 })).toBe('Unknown error');
  });

  it('returns fallback for object with empty error string', () => {
    expect(extractApiError({ error: '' })).toBe('Unknown error');
  });

  it('returns custom fallback when provided', () => {
    expect(extractApiError(null, 'Custom fallback')).toBe('Custom fallback');
  });
});
