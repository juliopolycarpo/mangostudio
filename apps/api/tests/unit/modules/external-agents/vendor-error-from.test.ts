import { describe, expect, it } from 'bun:test';

import { EnvironmentUnavailableError } from '../../../../src/lib/environment-unavailable';
import { vendorErrorFrom } from '../../../../src/modules/external-agents/application/external-turn-controller';

describe('vendorErrorFrom', () => {
  it('keeps an ordinary error message', () => {
    expect(vendorErrorFrom(new Error('boom'), 'turn-start')).toEqual({
      code: 'turn-start',
      message: 'boom',
    });
  });

  it('stores the fixed text for a connect failure, not its diagnostic', () => {
    const error = new EnvironmentUnavailableError('binary-missing', 'searched /home/alice/bin');
    const stored = vendorErrorFrom(error, 'turn-start');
    expect(
      stored.message,
      `(vendorErrorFrom): expected the fixed binary-missing text | received: ${stored.message}`
    ).toBe('The runtime for this environment is not installed on the hub.');
  });
});
