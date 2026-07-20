import { describe, expect, it } from 'bun:test';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import {
  ApiError,
  cn,
  DEFAULT_API_ERROR_FALLBACK,
  extractApiError,
  resolveApiErrorMessage,
} from '@/lib/utils';

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

describe('DEFAULT_API_ERROR_FALLBACK', () => {
  it('is a fixed neutral string', () => {
    expect(DEFAULT_API_ERROR_FALLBACK).toBe('An unknown error occurred');
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
    expect(extractApiError('')).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('returns fallback for null', () => {
    expect(extractApiError(null)).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('returns fallback for undefined', () => {
    expect(extractApiError(undefined)).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('returns fallback for object without error field', () => {
    expect(extractApiError({ status: 500 })).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('returns fallback for object with empty error string', () => {
    expect(extractApiError({ error: '' })).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('returns custom fallback when provided', () => {
    expect(extractApiError(null, 'Custom fallback')).toBe('Custom fallback');
  });
});

describe('ApiError', () => {
  it('exposes serverMessage when the API sent text', () => {
    const err = new ApiError({ error: 'slug already exists' });
    expect(err.serverMessage).toBe('slug already exists');
    expect(err.message).toBe('slug already exists');
  });

  it('uses the neutral fallback as message when the server sent no text', () => {
    const err = new ApiError(null);
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe(DEFAULT_API_ERROR_FALLBACK);
  });
});

describe('resolveApiErrorMessage', () => {
  const localized = 'Falha ao salvar';

  it('returns the server-provided message for ApiError', () => {
    expect(resolveApiErrorMessage(new ApiError({ error: 'slug already exists' }), localized)).toBe(
      'slug already exists'
    );
  });

  it('preserves a server message that matches the neutral fallback copy', () => {
    expect(
      resolveApiErrorMessage(new ApiError({ error: DEFAULT_API_ERROR_FALLBACK }), localized)
    ).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('returns the localized fallback when ApiError has no server message', () => {
    expect(resolveApiErrorMessage(new ApiError(null), localized)).toBe(localized);
  });

  it('returns the localized fallback for plain Error values', () => {
    expect(resolveApiErrorMessage(new Error('fetch failed'), localized)).toBe(localized);
    expect(resolveApiErrorMessage(new Error(DEFAULT_API_ERROR_FALLBACK), localized)).toBe(
      localized
    );
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
