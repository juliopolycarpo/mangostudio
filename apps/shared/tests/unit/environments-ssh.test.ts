import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  DEFAULT_SSH_RUNTIME_PATH,
  expandUserPath,
  quoteForRemoteShell,
  SSH_FORCED_OPTIONS,
  type SshEnvironmentConfig,
  SshEnvironmentConfigSchema,
  sshDestination,
  sshPreflightCommands,
  sshRuntimePath,
} from '../../src/environments';

function config(overrides: Partial<SshEnvironmentConfig> = {}): SshEnvironmentConfig {
  return { host: 'build-01.internal', ...overrides };
}

describe('ssh launch inputs', () => {
  it('forces every option the hub depends on, whatever ssh_config says', () => {
    // The launch argv is the SDK's preset; these are the same options as flags,
    // reused verbatim by the ssh command runner and asserted here so the two
    // cannot drift into disagreeing about what the hub insists on.
    expect(SSH_FORCED_OPTIONS).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'RemoteCommand=none',
    ]);
  });

  it('defaults the runtime path to the installer symlink, never a version', () => {
    expect(DEFAULT_SSH_RUNTIME_PATH).toBe('~/.mango/runtime/remote/current/mangostudio-runtime');
    expect(sshRuntimePath(config())).toBe(DEFAULT_SSH_RUNTIME_PATH);
  });

  it('prefers a configured remote path, ignoring one that is only whitespace', () => {
    expect(sshRuntimePath(config({ remoteRuntimePath: '~/bin/runtime' }))).toBe('~/bin/runtime');
    expect(sshRuntimePath(config({ remoteRuntimePath: '   ' }))).toBe(DEFAULT_SSH_RUNTIME_PATH);
  });

  it('builds the destination from user and host without interpolating either', () => {
    expect(sshDestination(config())).toBe('build-01.internal');
    expect(sshDestination(config({ user: 'deploy' }))).toBe('deploy@build-01.internal');
  });
});

describe('remote shell quoting', () => {
  it('keeps a leading ~/ expandable and quotes the rest', () => {
    // Quoting the tilde too would make the default path a literal `~`, which no
    // shell expands and no machine has.
    expect(quoteForRemoteShell('~/bin/mangostudio-runtime')).toBe("~/'bin/mangostudio-runtime'");
  });

  it('survives a path containing spaces', () => {
    expect(quoteForRemoteShell('/opt/mango studio/runtime')).toBe("'/opt/mango studio/runtime'");
  });

  it('renders shell metacharacters inert', () => {
    const quoted = quoteForRemoteShell('/tmp/x; touch /tmp/pwned');
    expect(quoted).toBe("'/tmp/x; touch /tmp/pwned'");
    // Nothing outside the quotes means nothing the remote shell would run.
    expect(quoted.slice(1, -1)).not.toContain("'");
  });

  it('escapes an embedded single quote instead of closing the string', () => {
    expect(quoteForRemoteShell("/tmp/it's/runtime")).toBe(String.raw`'/tmp/it'\''s/runtime'`);
  });

  it('quotes backticks and command substitution whole', () => {
    expect(quoteForRemoteShell('/tmp/`id`')).toBe("'/tmp/`id`'");
    expect(quoteForRemoteShell('/tmp/$(id)')).toBe("'/tmp/$(id)'");
  });

  it('quotes a ~user prefix rather than guessing at another shell', () => {
    expect(quoteForRemoteShell('~deploy/bin/runtime')).toBe("'~deploy/bin/runtime'");
  });

  it('expands only the current-user tilde form for hub-side path checks', () => {
    expect(expandUserPath('~/.ssh/id_ed25519', '/home/j')).toBe('/home/j/.ssh/id_ed25519');
    expect(expandUserPath('~', '/home/j')).toBe('/home/j');
    expect(expandUserPath('~other/.ssh/key', '/home/j')).toBe('~other/.ssh/key');
    expect(expandUserPath('/abs/key', '/home/j')).toBe('/abs/key');
  });
});

describe('ssh preflight commands', () => {
  it('omits batch and host-key forcing but disables ambient RemoteCommand', () => {
    const { reach, runtime } = sshPreflightCommands(config({ user: 'deploy', port: 2222 }));

    expect(reach).toBe("ssh -o RemoteCommand=none -p 2222 'deploy@build-01.internal' true");
    expect(reach).not.toContain('BatchMode');
    expect(reach).not.toContain('StrictHostKeyChecking');
    expect(runtime).toContain('--version');
    expect(runtime).toContain('RemoteCommand=none');
  });

  it('quotes an identity file that contains a space', () => {
    const { reach } = sshPreflightCommands(config({ identityFile: '/home/j/my keys/id_ed25519' }));

    expect(reach).toBe(
      "ssh -o RemoteCommand=none -i '/home/j/my keys/id_ed25519' 'build-01.internal' true"
    );
  });

  it('quotes a destination that carries shell metacharacters', () => {
    const { reach } = sshPreflightCommands(config({ host: 'box; touch /tmp/x' }));

    expect(reach).toBe("ssh -o RemoteCommand=none 'box; touch /tmp/x' true");
    expect(reach).not.toMatch(/^ssh box;/);
  });

  it('keeps a remote tilde from expanding in the local shell', () => {
    const { runtime } = sshPreflightCommands(config());

    expect(runtime).toContain("\\~/'.mango/runtime/remote/current/mangostudio-runtime'");
  });
});

describe('ssh config validation', () => {
  it('refuses a value that would read as an ssh option', () => {
    // A host named `-oProxyCommand=…` is remote code execution on the hub. The
    // schema is the first of three layers; `--` and argv-array spawning are the
    // other two.
    expect(Value.Check(SshEnvironmentConfigSchema, { host: '-oProxyCommand=id' })).toBe(false);
    expect(Value.Check(SshEnvironmentConfigSchema, { host: 'h', user: '-l' })).toBe(false);
    expect(
      Value.Check(SshEnvironmentConfigSchema, { host: 'h', identityFile: '-oIdentityFile=/x' })
    ).toBe(false);
    expect(Value.Check(SshEnvironmentConfigSchema, { host: 'h', remoteRuntimePath: '-x' })).toBe(
      false
    );
  });

  it('refuses a port outside the range and unknown fields', () => {
    expect(Value.Check(SshEnvironmentConfigSchema, { host: 'h', port: 0 })).toBe(false);
    expect(Value.Check(SshEnvironmentConfigSchema, { host: 'h', port: 70_000 })).toBe(false);
    expect(Value.Check(SshEnvironmentConfigSchema, { host: 'h', proxyJump: 'x' })).toBe(false);
  });

  it('accepts every permutation the dialog can produce', () => {
    expect(Value.Check(SshEnvironmentConfigSchema, { host: 'h' })).toBe(true);
    expect(
      Value.Check(SshEnvironmentConfigSchema, {
        host: 'h',
        user: 'deploy',
        port: 2222,
        identityFile: '/home/j/.ssh/id_ed25519',
        remoteRuntimePath: '~/bin/mangostudio-runtime',
      })
    ).toBe(true);
  });
});
