import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';

/**
 * Positive attestation for the in-process connector, which serves one signed-in
 * MangoStudio user. The digest changes when the OS credential home identity does
 * without exposing the path, uid, device or inode to the hub.
 */
export function createSingleUserHostExternalAgentIsolation(): ExternalIdentityIsolation {
  const home = realpathSync(homedir());
  const info = statSync(home);
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
