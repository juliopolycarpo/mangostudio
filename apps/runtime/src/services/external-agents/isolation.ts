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
  let home: string;
  let info: ReturnType<typeof statSync>;
  try {
    home = realpathSync(credentialHome);
    info = statSync(home);
  } catch {
    return undefined;
  }
  const identity = [
    process.platform,
    process.getuid?.() ?? 'no-uid',
    home,
    info.dev,
    info.ino,
  ].join('\0');
  return {
    method: 'single-user-host',
    credentialHomeFingerprint: `sha256:${createHash('sha256').update(identity).digest('hex')}`,
  };
}
