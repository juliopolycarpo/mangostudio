import { describe, expect, it } from 'bun:test';

import {
  EXTERNAL_PREFLIGHT_CODE,
  EXTERNAL_PREFLIGHT_STATUS,
  externalPreflightDetails,
} from '../../../../src/modules/external-agents/http/external-preflight';

describe('externalPreflightDetails', () => {
  it('maps an unreachable environment to 503 ENVIRONMENT_UNAVAILABLE with its reason', () => {
    expect(EXTERNAL_PREFLIGHT_STATUS['environment-unreachable']).toBe(503);
    expect(EXTERNAL_PREFLIGHT_CODE['environment-unreachable']).toBe('ENVIRONMENT_UNAVAILABLE');
    expect(EXTERNAL_PREFLIGHT_CODE.unavailable).toBe('PROVIDER_ERROR');
    expect(
      externalPreflightDetails({
        kind: 'environment-unreachable',
        message: 'The environment is unavailable.',
        reason: 'stopped-retrying',
      })
    ).toEqual({ details: { reason: 'stopped-retrying' } });
  });

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

  it('carries the reason of a CLI the operating system refused to start, without a build', () => {
    expect(
      externalPreflightDetails({
        kind: 'unsupported',
        message: 'This agent cannot run here right now.',
        unavailableReason: 'launch-refused',
      }),
      'expected details with the launch-refused reason alone'
    ).toEqual({ details: { unavailableReason: 'launch-refused' } });
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
