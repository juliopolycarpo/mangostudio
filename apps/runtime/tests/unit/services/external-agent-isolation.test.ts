import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createContainerExternalAgentIsolation,
  createOsAccountExternalAgentIsolation,
  createSingleUserHostExternalAgentIsolation,
  hasVendorCredentialMount,
  resolveExternalAgentIsolation,
} from '../../../src/services/external-agents/isolation';

const ABSENT_HOME = join(tmpdir(), 'mangostudio-absent-credential-home');

/** One `/proc/self/mountinfo` line for a mount point, in the real column layout. */
function mountLine(mountPoint: string): string {
  return `36 35 0:32 / ${mountPoint} rw,relatime shared:1 - ext4 /dev/sda1 rw`;
}

describe('single-user-host identity isolation', () => {
  it('fingerprints the credential home without exposing it', () => {
    const isolation = createSingleUserHostExternalAgentIsolation();

    expect(isolation?.method).toBe('single-user-host');
    expect(isolation?.credentialHomeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('degrades to no attestation when the credential home cannot be read', () => {
    // A Local connection carries file, shell and git access too. An unreadable
    // home may only cost the caller its attestation — and with it external
    // agents — never the whole environment.
    expect(createSingleUserHostExternalAgentIsolation(ABSENT_HOME)).toBeUndefined();
  });
});

describe('os-account identity isolation', () => {
  it('attests the account this process runs as', () => {
    const isolation = createOsAccountExternalAgentIsolation();
    expect(isolation?.method).toBe('os-account');
    expect(isolation?.credentialHomeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('degrades rather than throwing on an unreadable home', () => {
    expect(createOsAccountExternalAgentIsolation(ABSENT_HOME)).toBeUndefined();
  });

  /**
   * The fingerprint is compared across environments by the hub to find one
   * credential home reached by two MangoStudio users. Domain-separating it per
   * method would let the same shared account attest `os-account` on one route
   * and `container` on another and never collide — which is exactly the case
   * the comparison exists to catch.
   */
  it('produces the same digest for the same home whatever the method', () => {
    expect(createOsAccountExternalAgentIsolation()?.credentialHomeFingerprint).toBe(
      createSingleUserHostExternalAgentIsolation()?.credentialHomeFingerprint
    );
  });

  it('leaks neither the username nor the home path', () => {
    const fingerprint = createOsAccountExternalAgentIsolation()?.credentialHomeFingerprint ?? '';
    expect(fingerprint).not.toContain(homedir());
    for (const segment of homedir().split('/').filter(Boolean)) {
      expect(fingerprint).not.toContain(segment);
    }
  });
});

describe('container identity isolation', () => {
  const home = mkdtempSync(join(tmpdir(), 'mangostudio-container-home-'));

  it('attests a container whose credential home is its own', () => {
    const isolation = createContainerExternalAgentIsolation(home, mountLine('/proc'));
    expect(isolation?.method).toBe('container');
  });

  /**
   * The case that makes container isolation a check rather than a claim. A
   * `-v ~/.claude:/root/.claude` gives the container the *host's* vendor logins
   * while every other signal — its own uid namespace, its own filesystem — still
   * says "isolated".
   */
  it.each(['.claude', '.codex', '.cursor', '.config/cursor'])(
    'refuses when %s is bind-mounted from the host',
    (vendorDir) => {
      expect(
        createContainerExternalAgentIsolation(home, mountLine(join(home, vendorDir)))
      ).toBeUndefined();
    }
  );

  it('refuses when the whole home is mounted, not just a vendor directory', () => {
    expect(createContainerExternalAgentIsolation(home, mountLine(home))).toBeUndefined();
  });

  it('refuses when the mount table cannot be read at all', () => {
    // An unverifiable container is an unproven one. Attesting here would be
    // asserting the one property this function exists to check.
    expect(createContainerExternalAgentIsolation(home, undefined)).toBeUndefined();
  });

  it('decodes the octal escapes mountinfo uses for spaces', () => {
    const spaced = mkdtempSync(join(tmpdir(), 'mango space-'));
    const escaped = `${spaced.replace(/ /g, '\\040')}/.claude`;
    expect(hasVendorCredentialMount(spaced, mountLine(escaped))).toBe(true);
  });

  it('is unmoved by a mount that is merely near a vendor directory', () => {
    expect(hasVendorCredentialMount(home, mountLine(join(home, '.claude-backup')))).toBe(false);
  });
});

describe('resolveExternalAgentIsolation', () => {
  const home = mkdtempSync(join(tmpdir(), 'mangostudio-resolve-home-'));

  it('reports os-account off a container', () => {
    expect(
      resolveExternalAgentIsolation({ credentialHome: home, containerized: false })
    ).toMatchObject({ method: 'os-account' });
  });

  /**
   * Container first, because a container is also an OS account and the container
   * check is the stricter one. Reporting `os-account` for a containerized
   * runtime would skip the bind-mount test entirely.
   */
  it('takes the stricter container path when containerized', () => {
    expect(
      resolveExternalAgentIsolation({
        credentialHome: home,
        containerized: true,
        mountInfo: mountLine('/proc'),
      })
    ).toMatchObject({ method: 'container' });
    expect(
      resolveExternalAgentIsolation({
        credentialHome: home,
        containerized: true,
        mountInfo: mountLine(join(home, '.claude')),
      })
    ).toBeUndefined();
  });

  /**
   * `single-user-host` is a claim about the *hub* serving one user, which only
   * the in-process connector can make. A remote runtime asserting it would be
   * asserting something about a process on another machine.
   */
  it('never claims single-user-host from a runtime process', () => {
    for (const containerized of [false, true]) {
      const isolation = resolveExternalAgentIsolation({
        credentialHome: home,
        containerized,
        mountInfo: mountLine('/proc'),
      });
      expect(isolation?.method).not.toBe('single-user-host');
    }
  });

  it('attests nothing when the credential home is unreadable', () => {
    expect(
      resolveExternalAgentIsolation({ credentialHome: ABSENT_HOME, containerized: false })
    ).toBeUndefined();
  });
});
