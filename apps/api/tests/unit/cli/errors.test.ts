import { describe, expect, test } from 'bun:test';
import { RuntimeServiceError, RuntimeServiceManagementError } from '@mangostudio/runtime';
import { CliError, isOperatorError } from '../../../src/cli/errors';

// `dispatch` prints these plainly and exits 1; anything else keeps its stack
// trace, because it is a bug rather than something the operator can act on.
describe('isOperatorError', () => {
  test('accepts a CLI usage error', () => {
    expect(isOperatorError(new CliError('Unknown option for serve: --bogus'))).toBe(true);
  });

  test('accepts a service-manager refusal, so no call site has to wrap one', () => {
    const refusal = new RuntimeServiceManagementError(
      'runtime_service_no_session_bus',
      'No D-Bus session bus for systemd user services.'
    );
    expect(isOperatorError(refusal)).toBe(true);
  });

  test('rejects an unexpected failure', () => {
    expect(isOperatorError(new TypeError('cannot read property of undefined'))).toBe(false);
    expect(isOperatorError(new RuntimeServiceError('shell_execution', 'boom'))).toBe(false);
    expect(isOperatorError('not an error')).toBe(false);
  });
});
