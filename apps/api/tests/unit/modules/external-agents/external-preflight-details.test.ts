import { describe, expect, it } from 'bun:test';
import { externalPreflightDetails } from '../../../../src/modules/external-agents/http/external-preflight';

describe('externalPreflightDetails', () => {
  it('carries the reason and the required build of an outdated agent', () => {
    expect(
      externalPreflightDetails({
        kind: 'unsupported',
        message: 'This agent cannot run here right now.',
        unavailableReason: 'version-unsupported',
        requiredVersion: '0.154.0',
      }),
      'expected details naming version-unsupported and 0.154.0'
    ).toEqual({
      details: { unavailableReason: 'version-unsupported', requiredVersion: '0.154.0' },
    });
  });

  it('omits the required build when the refusal names none', () => {
    expect(
      externalPreflightDetails({
        kind: 'unsupported',
        message: 'This agent cannot run here right now.',
        unavailableReason: 'signed-out',
      }),
      'expected details with the reason alone'
    ).toEqual({ details: { unavailableReason: 'signed-out' } });
  });
});
