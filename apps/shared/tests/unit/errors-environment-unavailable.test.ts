/**
 * `ENVIRONMENT_UNAVAILABLE` is the public code for "the target environment's
 * runtime cannot be reached". It is distinct from `PROVIDER_ERROR`, which stays
 * the code for a failed model or connector provider.
 */

import { describe, expect, it } from 'bun:test';

import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
  type SSEErrorEvent,
  SSEErrorEventSchema,
  toProblemDetails,
} from '@mangostudio/shared/errors';
import Value from 'typebox/value';

describe('ENVIRONMENT_UNAVAILABLE', () => {
  it('is its own code, not an alias of PROVIDER_ERROR', () => {
    expect(ERROR_CODES.ENVIRONMENT_UNAVAILABLE).toBe('ENVIRONMENT_UNAVAILABLE');
    expect(ERROR_CODES.ENVIRONMENT_UNAVAILABLE).not.toBe(ERROR_CODES.PROVIDER_ERROR);
  });

  it('is a valid ApiErrorResponse with a reason in details', () => {
    const body: ApiErrorResponse = {
      error: 'The environment is unavailable.',
      code: ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
      details: { reason: 'backing-off' },
    };
    expect(
      Value.Check(ApiErrorResponseSchema, body),
      `(ApiErrorResponse): expected ENVIRONMENT_UNAVAILABLE body to validate | received: ${JSON.stringify(body)}`
    ).toBe(true);
  });

  it('is a valid terminal SSEErrorEvent', () => {
    const event: SSEErrorEvent = {
      type: 'error',
      error: 'The environment is unavailable.',
      code: ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
      done: true,
    };
    expect(
      Value.Check(SSEErrorEventSchema, event),
      `(SSEErrorEvent): expected ENVIRONMENT_UNAVAILABLE event to validate | received: ${JSON.stringify(event)}`
    ).toBe(true);
  });

  it('renders as a 503 problem with its own type URI and title', () => {
    expect(
      toProblemDetails(
        {
          error: 'The environment is unavailable.',
          code: ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
          details: { reason: 'unavailable' },
        },
        503
      )
    ).toMatchObject({
      type: 'https://mangostudio.dev/problems/environment-unavailable',
      title: 'Environment unavailable',
      status: 503,
      code: 'ENVIRONMENT_UNAVAILABLE',
    });
  });
});
