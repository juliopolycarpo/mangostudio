import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  findReleaseChecksum,
  INSTALL_ARCHIVE_SCRIPT,
  INSTALL_BINARY_SCRIPT,
  localRuntimeBuildCommand,
  localRuntimeBuildPath,
  releaseArchiveName,
  releaseAssetUrl,
  resolveLinuxPlatformId,
  wslLaunchCommand,
} from '../../../../src/modules/environments/domain/wsl-runtime-release';

const RUNTIME_PATH = '"$HOME/.mango/bin/mangostudio-runtime"';
const STAGED_PATH = '"$HOME/.mango/bin/mangostudio-runtime.incoming"';

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
      'exec "$HOME/.mango/bin/mangostudio-runtime" "$@"',
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
