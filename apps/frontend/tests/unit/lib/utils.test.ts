import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { buildGeneratedImageFilename } from '@/lib/download-filenames';
import { ApiError, cn, DEFAULT_API_ERROR_FALLBACK, resolveApiErrorMessage } from '@/lib/utils';

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
  it('matches en.errors.unknown', () => {
    expect(DEFAULT_API_ERROR_FALLBACK).toBe(en.errors.unknown);
  });
});

describe('ApiError', () => {
  it('returns the error field from an ApiErrorResponse object', () => {
    const err = new ApiError({ error: 'Something went wrong' });
    expect(err.serverMessage).toBe('Something went wrong');
    expect(err.message).toBe('Something went wrong');
  });

  it('returns a string value directly', () => {
    const err = new ApiError('Network error');
    expect(err.serverMessage).toBe('Network error');
    expect(err.message).toBe('Network error');
  });

  it('uses fallback for empty string input', () => {
    const err = new ApiError('');
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('uses fallback for null', () => {
    const err = new ApiError(null);
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('uses fallback for undefined', () => {
    const err = new ApiError(undefined);
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('uses fallback for object without error field', () => {
    const err = new ApiError({ status: 500 });
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('uses fallback for object with empty error string', () => {
    const err = new ApiError({ error: '' });
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe(DEFAULT_API_ERROR_FALLBACK);
  });

  it('exposes serverMessage when the API sent text', () => {
    const err = new ApiError({ error: 'slug already exists' });
    expect(err.serverMessage).toBe('slug already exists');
    expect(err.message).toBe('slug already exists');
  });

  it('preserves code and details when the API sent them', () => {
    const err = new ApiError({
      error: 'Checkout blocked',
      code: 'CHECKOUT_BLOCKED',
      details: { path: '/tmp/repo' },
    });
    expect(err.code).toBe('CHECKOUT_BLOCKED');
    expect(err.details).toEqual({ path: '/tmp/repo' });
  });

  it('reads an RFC 9457 problem document', () => {
    const err = new ApiError({
      type: 'https://mangostudio.dev/problems/checkout-blocked',
      title: 'Checkout blocked',
      status: 409,
      detail: 'Uncommitted changes would be overwritten',
      code: 'CHECKOUT_BLOCKED',
      details: { path: '/tmp/repo' },
    });

    expect(err.serverMessage).toBe('Uncommitted changes would be overwritten');
    expect(err.code).toBe('CHECKOUT_BLOCKED');
    expect(err.details).toEqual({ path: '/tmp/repo' });
  });

  it('renders the same message whichever representation arrived', () => {
    // The frontend asks for problem details, so every message users see now
    // comes from `detail`. It has to be the string `error` used to carry.
    const message = 'slug already exists';
    const legacy = new ApiError({ error: message, code: 'CONFLICT' });
    const problem = new ApiError({
      type: 'https://mangostudio.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail: message,
      code: 'CONFLICT',
    });

    expect(problem.message).toBe(legacy.message);
    expect(problem.serverMessage).toBe(legacy.serverMessage);
    expect(problem.code).toBe(legacy.code);
  });

  it('falls back to the problem title when there is no detail', () => {
    const err = new ApiError({ type: 'about:blank', title: 'Not found', status: 404 });
    expect(err.serverMessage).toBe('Not found');
  });

  it('uses the fallback for a problem document with no usable text', () => {
    const err = new ApiError({ type: 'about:blank', title: '', status: 500 });
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
