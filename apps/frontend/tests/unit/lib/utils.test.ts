import { describe, expect, it } from 'bun:test';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import { cn, extractApiError, resolveApiErrorMessage } from '@/lib/utils';

const defaultErrorFallback = 'An unknown error occurred';

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
    expect(extractApiError('')).toBe(defaultErrorFallback);
  });

  it('returns fallback for null', () => {
    expect(extractApiError(null)).toBe(defaultErrorFallback);
  });

  it('returns fallback for undefined', () => {
    expect(extractApiError(undefined)).toBe(defaultErrorFallback);
  });

  it('returns fallback for object without error field', () => {
    expect(extractApiError({ status: 500 })).toBe(defaultErrorFallback);
  });

  it('returns fallback for object with empty error string', () => {
    expect(extractApiError({ error: '' })).toBe(defaultErrorFallback);
  });

  it('returns custom fallback when provided', () => {
    expect(extractApiError(null, 'Custom fallback')).toBe('Custom fallback');
  });
});

describe('resolveApiErrorMessage', () => {
  const localized = 'Falha ao salvar';

  it('returns the server-provided message when the error carries one', () => {
    expect(resolveApiErrorMessage(new Error('slug already exists'), localized)).toBe(
      'slug already exists'
    );
  });

  it('returns the localized fallback for the shared last-resort message', () => {
    expect(resolveApiErrorMessage(new Error(defaultErrorFallback), localized)).toBe(localized);
  });

  it('returns the localized fallback for an empty message', () => {
    expect(resolveApiErrorMessage(new Error(''), localized)).toBe(localized);
  });

  it('returns the localized fallback for non-Error values', () => {
    expect(resolveApiErrorMessage('boom', localized)).toBe(localized);
    expect(resolveApiErrorMessage(null, localized)).toBe(localized);
    expect(resolveApiErrorMessage(undefined, localized)).toBe(localized);
  });
});

describe('buildGeneratedImageFilename', () => {
  it('uses the provider-neutral app prefix', () => {
    expect(buildGeneratedImageFilename('mangostudio', 'image-1')).toBe(
      'mangostudio-art-image-1.png'
    );
  });

  it('sanitizes unsafe filename segments', () => {
    expect(buildGeneratedImageFilename('mango studio', 'image/1')).toBe(
      'mango-studio-art-image-1.png'
    );
  });
});
