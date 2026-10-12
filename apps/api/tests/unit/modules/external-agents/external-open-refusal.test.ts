import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import {
  EXTERNAL_AGENT_CAPACITY_CODE,
  EXTERNAL_AGENT_TARGET_IDS,
} from '@mangostudio/shared/external-agents';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';
import { productDescriptorFor } from '../../../../src/modules/external-agents/domain/adapter-descriptors';
import {
  openFailureCodeFor,
  openRefusalFor,
} from '../../../../src/modules/external-agents/domain/external-open-refusal';
import { ToolArgumentError } from '../../../../src/services/tools/arg-parsing';

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
      openRefusalFor('cursor', new RemoteError('INTERNAL', 'no kind at all')),
      openRefusalFor(
        'cursor',
        new RemoteError('INTERNAL', 'workspace is not a directory', { kind: 'tool_argument' })
      ),
      openRefusalFor('cursor', new Error('plain')),
      openRefusalFor('cursor', 'not even an error'),
    ];

    expect(received).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('openRefusalFor, an agent that is missing or outdated', () => {
  const notInstalled = () =>
    new RemoteError('INTERNAL', 'executable is not installed', {
      kind: 'external_agent_not_installed',
    });
  const outdated = (details: Record<string, unknown> = {}) =>
    new RemoteError('UNAVAILABLE', 'too old', {
      kind: 'external_agent_version_unsupported',
      ...details,
    });

  it('presents a missing executable as not installed, with the install remedy', () => {
    for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
      expect({ targetId, refusal: openRefusalFor(targetId, notInstalled()) }).toEqual({
        targetId,
        refusal: { unavailableReason: 'not-installed', remedy: { kind: 'install' } },
      });
    }
  });

  it('keeps a tool_argument refusal generic, so a bad workspace is not blamed on the CLI', () => {
    // The runtime client turns that kind into a `ToolArgumentError`; the raw `RemoteError` is the
    // shape an older client path or a test double would still hand over.
    const refusals = [
      new ToolArgumentError('External-agent executable is not installed; expected a target.'),
      new RemoteError('INTERNAL', 'External-agent executable is not installed', {
        kind: 'tool_argument',
      }),
    ];

    expect(refusals.map((refusal) => openRefusalFor('codex', refusal))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('presents an unsupported version with the update remedy and the required version', () => {
    expect(openRefusalFor('claude', outdated({ requiredVersion: '2.1.211' }))).toEqual({
      unavailableReason: 'version-unsupported',
      remedy: { kind: 'update' },
      requiredVersion: '2.1.211',
    });
  });

  it('omits a required version the runtime did not name as a usable string', () => {
    const received = [undefined, '', '   ', 7, { version: '1' }, null].map(
      (requiredVersion) => openRefusalFor('codex', outdated({ requiredVersion }))?.requiredVersion
    );

    expect(received).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('bounds the required version to what the stream schema accepts', () => {
    const long = '9'.repeat(200);

    expect(openRefusalFor('codex', outdated({ requiredVersion: long }))?.requiredVersion).toBe(
      long.slice(0, 64)
    );
  });

  it('finds the version behind the hub wrappers', () => {
    const wrapped = new Error('open failed', { cause: outdated({ requiredVersion: '0.153.4' }) });

    expect(openRefusalFor('codex', wrapped)?.requiredVersion).toBe('0.153.4');
  });
});

describe('openFailureCodeFor', () => {
  const capacity = () =>
    new RemoteError('INTERNAL', 'External-agent session capacity is 4; close a session.', {
      kind: 'external_agent_capacity',
    });

  it('names a runtime at its session cap, which has no unavailable reason', () => {
    expect(openFailureCodeFor(capacity())).toBe(EXTERNAL_AGENT_CAPACITY_CODE);
    expect(openRefusalFor('codex', capacity())).toBeUndefined();
  });

  it('finds the refusal behind the hub wrappers', () => {
    expect(openFailureCodeFor(new Error('open failed', { cause: capacity() }))).toBe(
      EXTERNAL_AGENT_CAPACITY_CODE
    );
  });

  it('follows the cause chain a few links and no further', () => {
    const nested = (links: number): Error => {
      let error: Error = capacity();
      for (let depth = 0; depth < links; depth += 1) error = new Error('wrapped', { cause: error });
      return error;
    };

    expect([3, 4].map((links) => openFailureCodeFor(nested(links)))).toEqual([
      EXTERNAL_AGENT_CAPACITY_CODE,
      undefined,
    ]);
  });

  it('has nothing for any other failure, or for a kind that is only a property name', () => {
    const received = [
      openFailureCodeFor(
        new RemoteError('INTERNAL', 'x', { kind: 'external_agent_launch_failed' })
      ),
      openFailureCodeFor(new RemoteError('INTERNAL', 'x', { kind: 'tool_argument' })),
      openFailureCodeFor(new RemoteError('INTERNAL', 'x', { kind: '__proto__' })),
      openFailureCodeFor(new RemoteError('INTERNAL', 'no kind')),
      openFailureCodeFor(new Error('plain')),
      openFailureCodeFor('not even an error'),
    ];

    expect(received).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
