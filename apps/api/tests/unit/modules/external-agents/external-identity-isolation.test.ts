/**
 * The collision check, which is the half of the isolation proof that a runtime
 * cannot make about itself.
 *
 * Every case here is a shared credential home that looks perfectly isolated from
 * inside: same uid, same `$HOME`, same everything. The only thing that
 * distinguishes a dedicated per-user SSH account from a shared service account
 * four people's keys land in is that two MangoStudio users show up on the same
 * fingerprint — which is visible here and nowhere else.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import { createExternalIdentityIsolationRegistry } from '../../../../src/modules/external-agents/application/external-identity-isolation';

const ATTESTED: ExternalIdentityIsolation = {
  method: 'os-account',
  credentialHomeFingerprint: 'sha256:shared-home',
};

interface ReapCall {
  readonly userId?: string;
  readonly environmentId?: string;
}

function harness() {
  const reaps: ReapCall[] = [];
  const registry = createExternalIdentityIsolationRegistry({
    sessions: {
      reapScope: (scope) => {
        reaps.push(scope);
        return Promise.resolve();
      },
    },
  });
  return { registry, reaps };
}

describe('external identity isolation registry', () => {
  let subject: ReturnType<typeof harness>;

  beforeEach(() => {
    subject = harness();
  });

  it('passes an attestation through for the only user on a credential home', () => {
    expect(
      subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED })
    ).toEqual(ATTESTED);
  });

  it('withholds anything when the runtime attested nothing', () => {
    expect(subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1' })).toBeUndefined();
  });

  it('stays granted across repeated claims by the same user', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED })
      ).toEqual(ATTESTED);
    }
    expect(subject.reaps).toHaveLength(0);
  });

  it('treats one user reaching two environments as two per-user homes', () => {
    const other: ExternalIdentityIsolation = {
      method: 'container',
      credentialHomeFingerprint: 'sha256:other-home',
    };
    expect(
      subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED })
    ).toEqual(ATTESTED);
    expect(
      subject.registry.resolve({ userId: 'u1', environmentId: 'box-2', isolation: other })
    ).toEqual(other);
  });

  /**
   * Withdrawn from *both*, not kept for whoever arrived first. The danger is not
   * that the newcomer reaches the incumbent's `~/.claude`; it is that one vendor
   * login sits in that shared home and nobody can say whose it is, so the
   * incumbent is as likely to be spending the newcomer's subscription seat as
   * their own.
   */
  it('withdraws the attestation from everyone once a second user appears', () => {
    expect(
      subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED })
    ).toEqual(ATTESTED);
    expect(
      subject.registry.resolve({ userId: 'u2', environmentId: 'ssh-1', isolation: ATTESTED })
    ).toBeUndefined();
    expect(
      subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED })
    ).toBeUndefined();
  });

  it('reports the fingerprint as contested', () => {
    subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED });
    expect(subject.registry.isContested(ATTESTED.credentialHomeFingerprint)).toBe(false);
    subject.registry.resolve({ userId: 'u2', environmentId: 'ssh-1', isolation: ATTESTED });
    expect(subject.registry.isContested(ATTESTED.credentialHomeFingerprint)).toBe(true);
  });

  it('catches a shared home reached under two different transports', () => {
    subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED });
    expect(
      subject.registry.resolve({
        userId: 'u2',
        environmentId: 'wsl-9',
        isolation: { method: 'container', credentialHomeFingerprint: 'sha256:shared-home' },
      })
    ).toBeUndefined();
  });

  /**
   * The collision is usually discovered while the incumbent has a live vendor
   * process holding that shared home open. Refusing only the next turn would
   * leave the thing just decided to be unaccountable still running.
   */
  it('stops the sessions already running on a newly contested home', () => {
    subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED });
    subject.registry.resolve({ userId: 'u2', environmentId: 'ssh-1', isolation: ATTESTED });
    expect(subject.reaps.map((reap) => reap.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('reaps once on the transition rather than on every later poll', () => {
    subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED });
    subject.registry.resolve({ userId: 'u2', environmentId: 'ssh-1', isolation: ATTESTED });
    const afterContest = subject.reaps.length;
    for (let poll = 0; poll < 5; poll += 1) {
      subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED });
      subject.registry.resolve({ userId: 'u3', environmentId: 'ssh-1', isolation: ATTESTED });
    }
    expect(subject.reaps).toHaveLength(afterContest);
  });

  /**
   * A user closing a laptop does not un-share a credential home. Healing on
   * disconnect would restore the attestation the moment somebody went offline.
   */
  it('never heals a contested fingerprint', () => {
    subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED });
    subject.registry.resolve({ userId: 'u2', environmentId: 'ssh-1', isolation: ATTESTED });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: ATTESTED })
      ).toBeUndefined();
    }
  });

  /**
   * A paired machine belongs to whoever paired it. A second MangoStudio user
   * reaching it must not reach its owner's vendor logins — and since the two
   * cannot be told apart from a shared account, both lose the attestation.
   */
  it('withholds a paired machine from a second user', () => {
    const paired: ExternalIdentityIsolation = {
      method: 'single-user-host',
      credentialHomeFingerprint: 'sha256:owners-laptop',
    };
    expect(
      subject.registry.resolve({ userId: 'owner', environmentId: 'paired-1', isolation: paired })
    ).toEqual(paired);
    expect(
      subject.registry.resolve({ userId: 'guest', environmentId: 'paired-1', isolation: paired })
    ).toBeUndefined();
  });

  /**
   * No configuration path reaches this. The only input is what a runtime
   * presented, and the only transition is towards refusal.
   */
  it('offers no way to assert an attestation that was not presented', () => {
    expect(subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1' })).toBeUndefined();
    expect(
      subject.registry.resolve({ userId: 'u1', environmentId: 'ssh-1', isolation: undefined })
    ).toBeUndefined();
  });
});
