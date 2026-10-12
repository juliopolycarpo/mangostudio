import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import { EXTERNAL_AGENT_TARGET_IDS } from '@mangostudio/shared/external-agents';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';
import { productDescriptorFor } from '../../../../src/modules/external-agents/domain/adapter-descriptors';
import { openRefusalFor } from '../../../../src/modules/external-agents/domain/external-open-refusal';

const signedOut = (message = 'signed out') =>
  new RemoteError('UNAVAILABLE', message, { kind: 'external_agent_signed_out' });

describe('openRefusalFor', () => {
  it("offers each target's own sign-in command for a signed-out open", () => {
    for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
      expect({ targetId, refusal: openRefusalFor(targetId, signedOut()) }).toEqual({
        targetId,
        refusal: {
          unavailableReason: 'signed-out',
          remedy: { kind: 'sign-in', command: productDescriptorFor(targetId)?.loginCommand },
        },
      });
    }
  });

  it('never takes the command from the runtime message', () => {
    const hostile = signedOut('</code><img src=x onerror=alert(1)> rm -rf ~');

    expect(openRefusalFor('codex', hostile)?.remedy).toEqual({
      kind: 'sign-in',
      command: 'codex login',
    });
  });

  it('finds the runtime answer behind the hub wrappers', () => {
    const wrapped = new Error('open failed', { cause: signedOut() });

    expect(openRefusalFor('claude', wrapped)?.unavailableReason).toBe('signed-out');
  });

  it('presents a withdrawn consent as the denied reason, with no command', () => {
    expect(openRefusalFor('cursor', new RuntimeConsentDeniedError('not allowed'))).toEqual({
      unavailableReason: 'runtime-denied',
      remedy: { kind: 'contact-admin' },
    });
  });

  it('reads the kind as a name, not as a property of every object', () => {
    for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const refusal = openRefusalFor('cursor', new RemoteError('UNAVAILABLE', 'x', { kind }));
      expect({ kind, refusal }).toEqual({ kind, refusal: undefined });
    }
  });

  it('has nothing for an open failure without an existing presentation', () => {
    const received = [
      openRefusalFor(
        'cursor',
        new RemoteError('UNAVAILABLE', 'x', { kind: 'external_agent_launch_failed' })
      ),
      openRefusalFor(
        'cursor',
        new RemoteError('UNAVAILABLE', 'x', { kind: 'external_agent_version_unsupported' })
      ),
      openRefusalFor('cursor', new RemoteError('INTERNAL', 'no kind at all')),
      openRefusalFor('cursor', new Error('plain')),
      openRefusalFor('cursor', 'not even an error'),
    ];

    expect(received).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
