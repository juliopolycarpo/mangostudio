import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { openFailureMessage } from '../../../../src/features/terminal/open-failure-message';
import { ApiError } from '../../../../src/lib/utils';

function hubRefusal(code: string, details?: Record<string, string>): ApiError {
  return new ApiError({ error: 'server wording the user never sees', code, details });
}

describe('openFailureMessage', () => {
  it.each([
    ['disconnected', en.terminal.unavailable.disconnected],
    ['unavailable', en.terminal.unavailable.unavailable],
    ['runtime-update-required', en.terminal.unavailable.runtimeUpdateRequired],
  ])('words a details.reason of %s as the availability view does', (reason, expected) => {
    expect(openFailureMessage(en, hubRefusal('UNSUPPORTED', { reason }))).toBe(expected);
  });

  it.each([
    ['TERMINAL_DISABLED', en.terminal.unavailable.disabled],
    ['TERMINAL_LIMIT', en.terminal.unavailable.limit],
    ['TERMINAL_NOT_ISOLATED', en.terminal.unavailable.notIsolated],
  ])('words the %s code as the availability view does', (code, expected) => {
    expect(openFailureMessage(en, hubRefusal(code, { limit: '4' }))).toBe(expected);
  });

  it('falls back to the generic line for a reason the client does not know', () => {
    expect(openFailureMessage(en, hubRefusal('UNSUPPORTED', { reason: 'solar-flare' }))).toBe(
      en.terminal.openFailed
    );
  });

  it('falls back to the generic line for a failure that is not a hub refusal', () => {
    expect(openFailureMessage(en, new TypeError('Failed to fetch'))).toBe(en.terminal.openFailed);
    expect(openFailureMessage(en, hubRefusal('INTERNAL_ERROR'))).toBe(en.terminal.openFailed);
  });
});
