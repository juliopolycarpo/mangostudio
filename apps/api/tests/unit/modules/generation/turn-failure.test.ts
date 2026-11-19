import { describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '@mangostudio/shared/errors';

import {
  EnvironmentUnavailableError,
  environmentUnavailableText,
} from '../../../../src/lib/environment-unavailable';
import { GENERATION_DEADLINE_MESSAGE } from '../../../../src/lib/generation-deadline-response';
import {
  describeTurnFailure,
  getAbortInterruptionReason,
} from '../../../../src/modules/generation/application/turn-failure';
import { GenerationDeadlineError } from '../../../../src/services/providers/core/generation-deadline';

describe('describeTurnFailure', () => {
  it('uses the error message and its code for an ordinary failure', () => {
    const error = Object.assign(new Error('vendor exploded'), { code: 'vendor_code' });

    expect(describeTurnFailure(error)).toEqual({
      rawMessage: 'vendor exploded',
      message: 'vendor exploded',
      code: 'vendor_code',
    });
  });

  it('falls back to the generic text for a non-Error value', () => {
    expect(describeTurnFailure('boom')).toEqual({
      rawMessage: 'Stream generation failed',
      message: 'Stream generation failed',
    });
  });

  it('replaces an unreachable environment diagnostic with its fixed text', () => {
    const error = new EnvironmentUnavailableError('backing-off', 'raw diagnostic with /home/me');

    const description = describeTurnFailure(error);

    expect(description.message).toBe(environmentUnavailableText(error));
    expect(description.rawMessage).toBe('raw diagnostic with /home/me');
    expect(description.code).toBe(ERROR_CODES.ENVIRONMENT_UNAVAILABLE);
  });

  it('hides the provider detail a deadline error carries', () => {
    const description = describeTurnFailure(
      new GenerationDeadlineError('secret-vendor-host text generation', 120_000)
    );

    expect(description.message).toBe(GENERATION_DEADLINE_MESSAGE);
    expect(description.rawMessage).toContain('secret-vendor-host');
  });
});

describe('getAbortInterruptionReason', () => {
  it.each(['client_disconnect', 'user_cancelled'] as const)('keeps the %s reason', (reason) => {
    const controller = new AbortController();
    controller.abort(reason);

    expect(getAbortInterruptionReason(controller.signal)).toBe(reason);
  });

  it('reports unknown for an abort with another reason', () => {
    const controller = new AbortController();
    controller.abort();

    expect(getAbortInterruptionReason(controller.signal)).toBe('unknown');
  });
});
