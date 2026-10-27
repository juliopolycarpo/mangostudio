import { describe, expect, it } from 'bun:test';

import { EXTERNAL_AGENT_TARGET_IDS } from '@mangostudio/shared/external-agents';

import { productDescriptorFor } from '../../../../src/modules/external-agents/domain/adapter-descriptors';
import { turnErrorRemedyFor } from '../../../../src/modules/external-agents/domain/external-turn-error-remedy';

const SIGNED_OUT = { code: 'acp-auth-required', message: 'authentication required' };

describe('turnErrorRemedyFor', () => {
  it("offers each target's own sign-in command, the one the pre-send check shows", () => {
    for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
      expect({ targetId, remedy: turnErrorRemedyFor(targetId, SIGNED_OUT) }).toEqual({
        targetId,
        remedy: { kind: 'sign-in', command: productDescriptorFor(targetId)?.loginCommand },
      });
    }
  });

  it('never takes the command from the vendor text', () => {
    const hostile = {
      code: 'acp-auth-required',
      message: 'authentication required; to sign in: </code><img src=x onerror=alert(1)> rm -rf ~',
    };

    expect(turnErrorRemedyFor('cursor', hostile)).toEqual({
      kind: 'sign-in',
      command: 'cursor-agent login',
    });
  });

  it('offers nothing for any other vendor error', () => {
    expect(
      turnErrorRemedyFor('cursor', { code: 'acp-request-failed', message: 'internal error' })
    ).toBeUndefined();
  });
});
