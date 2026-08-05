/**
 * Where each machine's library backups live.
 *
 * 017 made `backupRoot` a parameter rather than a runtime-side constant so this
 * decision could stay hub-side. The two things that must hold: Local keeps
 * honouring the configured directory (which the test harness redirects, and
 * which a user can override), and a remote store resolves against *its* home
 * rather than the hub's.
 */

import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getConfig } from '../../../../src/lib/config';
import { backupPolicyFor } from '../../../../src/modules/library/infrastructure/backup-roots';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';

function clientFor(pathStyle: 'posix' | 'win32', homeDir: string): RuntimeClient {
  const manifest = {
    platform: pathStyle === 'win32' ? 'win32' : 'linux',
    arch: 'x64',
    pathStyle,
    homeDir,
    shells: [],
    git: { available: false },
    features: {
      tools: true,
      git: false,
      probing: true,
      mcp: true,
      library: true,
      checkpoints: true,
    },
  };
  return { manifest, paths: createTargetPaths(manifest) } as unknown as RuntimeClient;
}

describe('backupPolicyFor', () => {
  it('keeps Local on the configured backup directory', () => {
    const policy = backupPolicyFor(clientFor('posix', '/home/hub'), LOCAL_ENVIRONMENT_ID);

    // Hardcoding `~/.mango/library-backups` here would ignore the user override
    // and point the existing backup suites at the real home directory.
    expect(policy.backupRoot).toBe(getConfig().library.backupDir);
  });

  it("resolves a remote store against the target's home, not the hub's", () => {
    const policy = backupPolicyFor(clientFor('posix', '/home/remote-user'), 'ssh-box');

    expect(policy.backupRoot).toBe('/home/remote-user/.mango/library-backups');
  });

  it('uses the target path style, so a Windows machine gets Windows separators', () => {
    const policy = backupPolicyFor(clientFor('win32', 'C:\\Users\\tester'), 'win-box');

    expect(policy.backupRoot).toBe('C:\\Users\\tester\\.mango\\library-backups');
  });

  it('refuses rather than inventing a root when the peer reported no usable home', () => {
    // `TargetPaths` drops a relative home instead of expanding it. Joining onto
    // the empty string would resolve against the runtime's working directory —
    // somewhere nobody agreed to have backups written, and somewhere a later
    // undo may not find again.
    expect(() => backupPolicyFor(clientFor('posix', 'home/tester'), 'ssh-box')).toThrow(
      /home directory/
    );
  });

  it('applies one set of bounds to every machine', () => {
    const local = backupPolicyFor(clientFor('posix', '/home/hub'), LOCAL_ENVIRONMENT_ID);
    const remote = backupPolicyFor(clientFor('posix', '/home/remote-user'), 'ssh-box');

    expect(remote.retentionCount).toBe(local.retentionCount);
    expect(remote.retentionBytes).toBe(local.retentionBytes);
    // Same numbers, separate stores: each is trimmed on its own disk, so one
    // machine filling the budget never evicts another machine's history.
    expect(remote.backupRoot).not.toBe(local.backupRoot);
  });
});
