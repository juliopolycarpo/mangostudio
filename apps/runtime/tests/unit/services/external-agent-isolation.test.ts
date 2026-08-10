import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  /**
   * The path assertion only. A per-segment check would compare short path
   * components against 64 characters of hex, and a segment like `ada` — or any
   * one- or two-character hex-shaped name — appears inside a random digest often
   * enough to fail a correct implementation.
   */
  it('leaks the home path into neither the digest nor its prefix', () => {
    const fingerprint = createOsAccountExternalAgentIsolation()?.credentialHomeFingerprint ?? '';
    expect(fingerprint).not.toContain(homedir());
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
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

  /**
   * Equality matching would miss this, and it is the *cheapest* way to share a
   * login: mounting the credential file itself rather than its directory.
   */
  it.each([
    ['.claude/.credentials.json', 'the Claude credential file'],
    ['.codex/auth.json', 'the Codex credential file'],
    ['.claude/settings.json/deeper', 'anything nested below a vendor directory'],
  ])('refuses a mount at %s (%s)', (relative) => {
    expect(hasVendorCredentialMount(home, mountLine(join(home, relative)))).toBe(true);
  });

  /** Mounting an ancestor brings the vendor directories underneath it along. */
  it('refuses a mount above the credential home', () => {
    expect(hasVendorCredentialMount(home, mountLine(dirname(home)))).toBe(true);
  });

  /**
   * Every container has `/` in its mount table — its own rootfs. Counting that
   * as an ancestor of the credential home would refuse every container in
   * existence and make the check useless rather than strict.
   */
  it('does not treat the container rootfs as a shared credential mount', () => {
    expect(hasVendorCredentialMount(home, mountLine('/'))).toBe(false);
    expect(
      createContainerExternalAgentIsolation(home, `${mountLine('/')}\n${mountLine('/proc')}`)
    ).toMatchObject({ method: 'container' });
  });

  /**
   * The vendors let a user move their credential home, and the adapters pass
   * those variables through. Checking only the defaults would leave relocation
   * as a way to mount host credentials past this function untouched.
   */
  it('guards a relocated Codex home', () => {
    expect(
      hasVendorCredentialMount(home, mountLine('/mnt/host-codex'), {
        CODEX_HOME: '/mnt/host-codex',
      })
    ).toBe(true);
  });

  it('guards a relocated Claude configuration directory', () => {
    expect(
      hasVendorCredentialMount(home, mountLine('/mnt/host-claude/.credentials.json'), {
        CLAUDE_CONFIG_DIR: '/mnt/host-claude',
      })
    ).toBe(true);
  });

  it('guards vendor subdirectories of a relocated XDG config home', () => {
    expect(
      hasVendorCredentialMount(home, mountLine('/mnt/xdg/cursor'), {
        XDG_CONFIG_HOME: '/mnt/xdg',
      })
    ).toBe(true);
    // The base itself is not guarded: a config volume that carries no vendor
    // directory exposes no credential, and refusing it would reject ordinary
    // containers for nothing.
    expect(
      hasVendorCredentialMount(home, mountLine('/mnt/xdg/some-other-app'), {
        XDG_CONFIG_HOME: '/mnt/xdg',
      })
    ).toBe(false);
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
