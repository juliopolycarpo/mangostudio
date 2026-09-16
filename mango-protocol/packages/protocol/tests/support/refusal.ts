/** The refusal assertion every suite shares. */

import { CodecError } from '../../src/errors';

/**
 * Runs `body` and returns the `CodecError` it threw. Anything else is a test
 * failure: a call that returned, or an error of another class, proves nothing
 * about a refusal.
 *
 * @example
 * expect(refusalOf(() => decodeLine('{')).kind).toBe('invalid-json');
 */
export function refusalOf(body: () => unknown, subject = 'the call'): CodecError {
  try {
    body();
  } catch (error) {
    if (error instanceof CodecError) return error;
    throw error;
  }
  throw new Error(`expected a CodecError; ${subject} returned normally`);
}
