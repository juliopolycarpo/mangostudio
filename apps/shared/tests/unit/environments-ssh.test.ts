import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  DEFAULT_SSH_RUNTIME_PATH,
  expandUserPath,
  quoteForRemoteShell,
  SSH_FORCED_OPTIONS,
  type SshEnvironmentConfig,
  SshEnvironmentConfigSchema,
  sshDestination,
  sshLaunchCommand,
  sshPreflightCommands,
} from '../../src/environments';

function config(overrides: Partial<SshEnvironmentConfig> = {}): SshEnvironmentConfig {
  return { host: 'build-01.internal', ...overrides };
}

describe('ssh launch command', () => {
  it('forces every option the hub depends on, whatever ssh_config says', () => {
    const { command, args } = sshLaunchCommand(config());

    expect(command).toBe('ssh');
    for (let index = 0; index < SSH_FORCED_OPTIONS.length; index += 2) {
      const flag = SSH_FORCED_OPTIONS[index] as string;
      const value = SSH_FORCED_OPTIONS[index + 1] as string;
      expect(args.indexOf(value)).toBeGreaterThan(-1);
      expect(args[args.indexOf(value) - 1]).toBe(flag);
    }
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ControlPath=none');
    expect(args).toContain('RemoteCommand=none');
  });

  it('ends option parsing before the destination and the remote command', () => {
    const { args } = sshLaunchCommand(config({ user: 'deploy', port: 2222 }));

    expect(args.at(-3)).toBe('--');
    expect(args.at(-2)).toBe('deploy@build-01.internal');
    expect(args.at(-1)).toBe(`~/${"'"}.mango/runtime/remote/current/mangostudio-runtime'`);
    expect(args).toContain('-T');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
  });

  it('passes an identity file as argv and pins ssh to it', () => {
    const { args } = sshLaunchCommand(config({ identityFile: '/home/j/.ssh/build_ed25519' }));

    expect(args[args.indexOf('-i') + 1]).toBe('/home/j/.ssh/build_ed25519');
    expect(args).toContain('IdentitiesOnly=yes');
  });

  it('omits the optional flags entirely when nothing configured them', () => {
    const { args } = sshLaunchCommand(config());

    expect(args).not.toContain('-i');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('IdentitiesOnly=yes');
  });

  it('defaults the runtime path to the installer symlink, never a version', () => {
    const { args } = sshLaunchCommand(config());

    expect(DEFAULT_SSH_RUNTIME_PATH).toBe('~/.mango/runtime/remote/current/mangostudio-runtime');
    expect(args.at(-1)).toContain('.mango/runtime/remote/current/mangostudio-runtime');
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
  it('omits the forced options, because running it by hand is how a key is trusted', () => {
    const { reach, runtime } = sshPreflightCommands(config({ user: 'deploy', port: 2222 }));

    expect(reach).toBe("ssh -p 2222 'deploy@build-01.internal' true");
    expect(reach).not.toContain('BatchMode');
    expect(reach).not.toContain('StrictHostKeyChecking');
    expect(runtime).toContain('--version');
  });

  it('quotes an identity file that contains a space', () => {
    const { reach } = sshPreflightCommands(config({ identityFile: '/home/j/my keys/id_ed25519' }));

    expect(reach).toBe("ssh -i '/home/j/my keys/id_ed25519' 'build-01.internal' true");
  });

  it('quotes a destination that carries shell metacharacters', () => {
    const { reach } = sshPreflightCommands(config({ host: 'box; touch /tmp/x' }));

    expect(reach).toBe("ssh 'box; touch /tmp/x' true");
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
