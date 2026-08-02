import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  DISTRO_RUNTIME_PATH,
  distroRuntimeConfigAfterInstall,
  findReleaseChecksum,
  INSTALL_ARCHIVE_SCRIPT,
  INSTALL_BINARY_SCRIPT,
  localRuntimeBuildCommand,
  localRuntimeBuildPath,
  PROBE_SLOT_SCRIPT,
  parseDistroSlotProbe,
  REMOVE_LEGACY_RUNTIME_SCRIPT,
  releaseArchiveName,
  releaseAssetUrl,
  resolveLinuxPlatformId,
  SETUP_FULL_SCRIPT,
  VERSION_SCRIPT,
  wslLaunchCommand,
} from '../../../../src/modules/environments/domain/wsl-runtime-release';

const SLOT_DIR = '"$HOME/.mango/runtime/wsl';
const RUNTIME_PATH = `${SLOT_DIR}/$1/mangostudio-runtime"`;
const STAGED_PATH = `${SLOT_DIR}/$1/mangostudio-runtime.incoming"`;
const CURRENT_BINARY = `${SLOT_DIR}/current/mangostudio-runtime"`;

const GLIBC = 'ldd (Ubuntu GLIBC 2.35-0ubuntu3.6) 2.35';
const MUSL = 'musl libc (x86_64)';

describe('resolveLinuxPlatformId', () => {
  it('maps uname machine names to release platforms', () => {
    expect(resolveLinuxPlatformId({ machine: 'x86_64', libc: GLIBC })).toBe('linux-x64');
    expect(resolveLinuxPlatformId({ machine: 'aarch64', libc: GLIBC })).toBe('linux-arm64');
    expect(resolveLinuxPlatformId({ machine: ' ARM64\n', libc: GLIBC })).toBe('linux-arm64');
  });

  it('picks the musl build for a musl distribution', () => {
    // Alpine on WSL is a real configuration, and uname alone cannot tell it
    // apart from a glibc distribution on the same architecture.
    expect(resolveLinuxPlatformId({ machine: 'x86_64', libc: MUSL })).toBe('linux-x64-musl');
    expect(resolveLinuxPlatformId({ machine: 'aarch64', libc: MUSL })).toBe('linux-arm64-musl');
  });

  it('refuses an architecture with no published build', () => {
    expect(resolveLinuxPlatformId({ machine: 'riscv64', libc: GLIBC })).toBeNull();
    expect(resolveLinuxPlatformId({ machine: '', libc: '' })).toBeNull();
  });
});

describe('release asset naming', () => {
  it('builds the archive name and its download URL', () => {
    expect(releaseArchiveName('1.2.3', 'linux-x64')).toBe('mangostudio-1.2.3-linux-x64.tar.gz');
    expect(releaseAssetUrl('1.2.3', 'mangostudio-1.2.3-linux-x64.tar.gz')).toBe(
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3/mangostudio-1.2.3-linux-x64.tar.gz'
    );
  });
});

describe('install scripts', () => {
  it('publishes the runtime with a rename rather than writing over it', () => {
    // A distribution can be running a runtime while it is provisioned again, and
    // Linux refuses to open a busy executable for writing.
    for (const script of [INSTALL_ARCHIVE_SCRIPT, INSTALL_BINARY_SCRIPT]) {
      expect(script).toContain(`mv -f ${STAGED_PATH} ${RUNTIME_PATH}`);
      expect(script).not.toContain(`> ${RUNTIME_PATH}`);
    }
  });

  it('unpacks one member from a release archive and takes a local build whole', () => {
    expect(INSTALL_ARCHIVE_SCRIPT).toContain(`tar -xzf - -O mangostudio-runtime > ${STAGED_PATH}`);
    expect(INSTALL_BINARY_SCRIPT).toContain(`cat > ${STAGED_PATH}`);
    expect(INSTALL_BINARY_SCRIPT).not.toContain('tar');
  });

  it('marks the runtime executable before it takes the live name', () => {
    for (const script of [INSTALL_ARCHIVE_SCRIPT, INSTALL_BINARY_SCRIPT]) {
      const chmod = script.indexOf(`chmod +x ${STAGED_PATH}`);
      const rename = script.indexOf('mv -f ');

      expect(chmod).toBeGreaterThan(-1);
      expect(chmod).toBeLessThan(rename);
    }
  });

  it('takes the version as an argument, never as text inside the script', () => {
    // A value spliced into one of these strings would be parsed by the
    // distribution's shell; `$1` is an argv entry the shell only expands.
    for (const script of [INSTALL_ARCHIVE_SCRIPT, INSTALL_BINARY_SCRIPT]) {
      expect(script).toContain('/$1/');
      expect(script).toContain('mkdir -p "$HOME/.mango/runtime/wsl/$1"');
    }
  });

  it('points current at the version it just installed', () => {
    // 013's ssh default and 023's service unit both embed `current`, so an
    // upgrade that did not move it would leave them on bytes that are gone.
    for (const script of [INSTALL_ARCHIVE_SCRIPT, INSTALL_BINARY_SCRIPT]) {
      expect(script).toContain('ln -sfn "$1" "$HOME/.mango/runtime/wsl/current"');
      expect(script.indexOf('ln -sfn')).toBeGreaterThan(script.indexOf('mv -f '));
    }
  });
});

describe('slot scripts', () => {
  it('launches, versions, and consents through the current link', () => {
    for (const script of [VERSION_SCRIPT, SETUP_FULL_SCRIPT]) {
      expect(script).toContain(CURRENT_BINARY);
    }
    expect(SETUP_FULL_SCRIPT).toContain('setup --profile full --yes');
    expect(DISTRO_RUNTIME_PATH).toBe('~/.mango/runtime/wsl/current/mangostudio-runtime');
  });

  it('removes the unversioned binary the previous layout left behind', () => {
    expect(REMOVE_LEGACY_RUNTIME_SCRIPT).toContain('rm -f "$HOME/.mango/bin/mangostudio-runtime"');
    // Silence would leave the hub unable to say whether anything was there.
    expect(REMOVE_LEGACY_RUNTIME_SCRIPT).toContain('echo removed');
  });
});

describe('parseDistroSlotProbe', () => {
  it('reads the home directory and the config out of one round trip', () => {
    expect(PROBE_SLOT_SCRIPT).toContain('"$HOME"');
    const probe = parseDistroSlotProbe(
      '/home/dev\n{"schemaVersion":1,"slot":"wsl","version":"1.2.3"}\n'
    );

    expect(probe.home).toBe('/home/dev');
    expect(probe.config?.version).toBe('1.2.3');
  });

  it('reports a distribution with no config yet', () => {
    expect(parseDistroSlotProbe('/home/dev\n')).toEqual({ home: '/home/dev', config: null });
    expect(parseDistroSlotProbe('/home/dev')).toEqual({ home: '/home/dev', config: null });
  });

  it('treats a config it cannot read as absent, which re-provisions and rewrites it', () => {
    expect(parseDistroSlotProbe('/home/dev\n{ truncated').config).toBeNull();
    expect(
      parseDistroSlotProbe('/home/dev\n{"schemaVersion":1,"slot":"nowhere"}').config
    ).toBeNull();
  });
});

describe('distroRuntimeConfigAfterInstall', () => {
  const params = {
    home: '/home/dev',
    version: '1.2.4',
    digest: `sha256:${'a'.repeat(64)}`,
    hubVersion: '1.2.4',
    hubHost: 'win-desktop',
    at: '2026-08-02T00:00:00.000Z',
  };

  it('records what was installed and where', () => {
    const config = distroRuntimeConfigAfterInstall({ ...params, stored: null });

    expect(config).toMatchObject({
      schemaVersion: 1,
      slot: 'wsl',
      source: 'provisioned',
      version: '1.2.4',
      binaryPath: '/home/dev/.mango/runtime/wsl/1.2.4/mangostudio-runtime',
      digest: params.digest,
      installedBy: { hubVersion: '1.2.4', host: 'win-desktop', transport: 'wsl' },
    });
  });

  it('leaves consent exactly as the distribution recorded it', () => {
    // Upgrades replace bytes, never the answer somebody gave about what a hub
    // may do here.
    const config = distroRuntimeConfigAfterInstall({
      ...params,
      stored: {
        schemaVersion: 1,
        slot: 'wsl',
        version: '1.2.3',
        profile: 'readonly',
        allow: { fsRead: true, shell: false },
        setup: { state: 'configured', by: 'cli' },
      },
    });

    expect(config.profile).toBe('readonly');
    expect(config.allow).toEqual({ fsRead: true, shell: false });
    expect(config.setup).toEqual({ state: 'configured', by: 'cli' });
    expect(config.version).toBe('1.2.4');
  });
});

describe('local runtime build', () => {
  it('looks where this repository writes its own Linux builds', () => {
    expect(localRuntimeBuildPath('/repo', 'linux-x64')).toBe(
      join('/repo', '.mango', 'out', 'linux-x64', 'mangostudio-runtime')
    );
    expect(localRuntimeBuildPath('/repo', 'linux-arm64-musl')).toBe(
      join('/repo', '.mango', 'out', 'linux-arm64-musl', 'mangostudio-runtime')
    );
  });

  it('names a build with no version stamp, so the runtime reports dev like its hub', () => {
    const command = localRuntimeBuildCommand('linux-x64-musl', '/repo/out/mangostudio-runtime');

    expect(command).toContain('--target=bun-linux-x64-musl');
    expect(command).toContain('--outfile /repo/out/mangostudio-runtime');
    expect(command).not.toContain('VERSION');
  });
});

describe('wslLaunchCommand', () => {
  it('builds argv the stdio spawn can append --stdio to', () => {
    const launch = wslLaunchCommand('Ubuntu-22.04');

    expect(launch.command).toBe('wsl.exe');
    // What the spawn ultimately runs. `"$@"` is where the appended flag lands.
    expect([...launch.args, '--stdio']).toEqual([
      '-d',
      'Ubuntu-22.04',
      '--exec',
      'sh',
      '-c',
      'exec "$HOME/.mango/runtime/wsl/current/mangostudio-runtime" "$@"',
      'mangostudio-runtime',
      '--stdio',
    ]);
  });

  it('carries a distribution name as one argument whatever it contains', () => {
    // Distribution names are user input: spaces, quotes, and shell characters
    // are argv entries here, never text some shell will parse.
    const hostile = 'My Distro"; rm -rf /; #';
    const launch = wslLaunchCommand(hostile);

    expect(launch.args[1]).toBe(hostile);
    expect(launch.args.filter((argument) => argument.includes('rm -rf'))).toEqual([hostile]);
  });
});

describe('findReleaseChecksum', () => {
  const checksums = [
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  mangostudio-1.2.3-linux-x64.tar.gz',
    'FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210  *mangostudio-1.2.3-linux-arm64.tar.gz',
    '',
  ].join('\n');

  it('reads a digest and lowercases it', () => {
    expect(findReleaseChecksum(checksums, 'mangostudio-1.2.3-linux-x64.tar.gz')).toBe(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
  });

  it('ignores the binary marker sha256sum writes', () => {
    expect(findReleaseChecksum(checksums, 'mangostudio-1.2.3-linux-arm64.tar.gz')).toBe(
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
    );
  });

  it('returns null when the release does not publish the asset', () => {
    expect(findReleaseChecksum(checksums, 'mangostudio-1.2.3-linux-x64-musl.tar.gz')).toBeNull();
    expect(findReleaseChecksum('', 'anything.tar.gz')).toBeNull();
  });

  it('does not match a name that merely shares a prefix', () => {
    expect(findReleaseChecksum(checksums, 'mangostudio-1.2.3-linux-x64.tar')).toBeNull();
  });
});
