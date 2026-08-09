import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';

/**
 * Positive attestation for the in-process connector, which serves one signed-in
 * MangoStudio user. The digest changes when the OS credential home identity does
 * without exposing the path, uid, device or inode to the hub.
 *
 * Returns `undefined` when the credential home cannot be read — unset, dangling
 * or unreadable. Attestation is optional by contract, and absence already means
 * unproven, so degrading keeps the Local environment's file, shell and git
 * access working while still withholding external agents. A throw here would
 * instead reject the whole Local connect attempt.
 *
 * `credentialHome` defaults to this account's home and is a parameter so the
 * unreadable path can be exercised without mutating the process environment.
 */
export function createSingleUserHostExternalAgentIsolation(
  credentialHome: string = homedir()
): ExternalIdentityIsolation | undefined {
  const identity = hostIdentity(credentialHome);
  if (identity === undefined) return undefined;
  return {
    method: 'single-user-host',
    credentialHomeFingerprint: `sha256:${createHash('sha256').update(identity).digest('hex')}`,
  };
}

/**
 * A key for digests that must not be reproducible off this machine.
 *
 * Some values an adapter reports are digests of low-entropy personal data — an
 * email address above all — where a plain hash is not an identifier but a
 * *confirmation oracle*: anyone holding the digest and a guess can check the
 * guess offline. Keying the digest with something only this host knows removes
 * that, while keeping the value stable across restarts so it can still do the
 * one job it has, which is noticing that the identity behind it changed.
 *
 * Derived from the same material as the attestation above — the credential
 * home's device and inode are the parts an outsider cannot guess — but through
 * a **separate domain**, so publishing `credentialHomeFingerprint` never
 * reveals this key. Callers must degrade rather than fall back to an unkeyed
 * digest when it is `undefined`.
 */
export function hostLocalDigestKey(credentialHome: string = homedir()): string | undefined {
  const identity = hostIdentity(credentialHome);
  if (identity === undefined) return undefined;
  return createHash('sha256').update(`mangostudio/host-digest-key\0${identity}`).digest('hex');
}

/** The unpublished material both digests above are built from. */
function hostIdentity(credentialHome: string): string | undefined {
  let home: string;
  let info: ReturnType<typeof statSync>;
  try {
    home = realpathSync(credentialHome);
    info = statSync(home);
  } catch {
    return undefined;
  }
  return [process.platform, process.getuid?.() ?? 'no-uid', home, info.dev, info.ino].join('\0');
}
