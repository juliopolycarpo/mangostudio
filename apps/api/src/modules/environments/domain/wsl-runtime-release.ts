/**
 * Which release artifact a WSL distribution needs, and the shell it is placed
 * with.
 *
 * A Windows hub cannot run its own runtime binary inside a Linux distribution,
 * so the matching Linux build is fetched from the release the hub was cut from.
 * There is no standalone runtime asset yet — the runtime ships inside the
 * platform archive beside the hub binary — so the archive is what gets fetched
 * and the distribution's own `tar` extracts the one member that matters. That
 * costs the hub binary's bytes once per version and needs nothing from the
 * release pipeline that is not already published.
 *
 * Every script here is a constant. Distribution names are user input and travel
 * as argv entries, never inside one of these strings.
 */

import type { RuntimeLaunchCommand } from '../../../lib/runtime-paths';

const REPOSITORY = 'juliopolycarpo/mangostudio';

/** Where the runtime lands inside a distribution. */
const DISTRO_RUNTIME_DIR = '.mango/bin';
const RUNTIME_ARCHIVE_MEMBER = 'mangostudio-runtime';

export type LinuxPlatformId = 'linux-x64' | 'linux-arm64' | 'linux-x64-musl' | 'linux-arm64-musl';

export interface DistroPlatformProbe {
  /** `uname -m` output. */
  readonly machine: string;
  /** First line of `ldd --version`, which names the C library. */
  readonly libc: string;
}

/**
 * Reports both halves of the target triple in one round trip. Alpine on WSL is
 * a real configuration and needs the musl build, which `uname -m` alone cannot
 * distinguish from glibc.
 */
export const PLATFORM_PROBE_SCRIPT = 'uname -m; (ldd --version 2>&1 || true) | head -n 1';

/**
 * Unpacks one member of the archive from stdin and marks it executable. `$HOME`
 * is expanded by the distribution's own shell: the hub does not know where a
 * distribution's home directory is, and `wsl.exe --exec` performs no expansion.
 */
export const INSTALL_SCRIPT =
  'set -e; ' +
  `mkdir -p "$HOME/${DISTRO_RUNTIME_DIR}"; ` +
  `tar -xzf - -C "$HOME/${DISTRO_RUNTIME_DIR}" ${RUNTIME_ARCHIVE_MEMBER}; ` +
  `chmod +x "$HOME/${DISTRO_RUNTIME_DIR}/${RUNTIME_ARCHIVE_MEMBER}"`;

/**
 * Runs the installed runtime with whatever arguments follow. `"$@"` is what
 * lets the stdio launcher append `--stdio` the way it does for every other
 * transport, instead of this needing its own spawn path.
 */
const LAUNCH_SCRIPT = `exec "$HOME/${DISTRO_RUNTIME_DIR}/${RUNTIME_ARCHIVE_MEMBER}" "$@"`;

/** Reports the installed runtime's version, and fails when there is not one. */
export const VERSION_SCRIPT = `exec "$HOME/${DISTRO_RUNTIME_DIR}/${RUNTIME_ARCHIVE_MEMBER}" --version`;

/**
 * argv that starts the runtime inside a distribution. WSL is a launcher, not a
 * protocol: what comes out of this is fed to the same stdio spawn every other
 * local runtime uses, which appends its own `--stdio` — the script's `"$@"` is
 * where that lands. `$0` is set so anything the shell reports names the runtime
 * rather than `sh`.
 * // Usage: wslLaunchCommand('Ubuntu-22.04')
 */
export function wslLaunchCommand(distro: string): RuntimeLaunchCommand {
  return {
    command: 'wsl.exe',
    args: ['-d', distro, '--exec', 'sh', '-c', LAUNCH_SCRIPT, RUNTIME_ARCHIVE_MEMBER],
  };
}

export function resolveLinuxPlatformId(probe: DistroPlatformProbe): LinuxPlatformId | null {
  const machine = probe.machine.trim().toLowerCase();
  const architecture =
    machine === 'x86_64' || machine === 'amd64'
      ? 'linux-x64'
      : machine === 'aarch64' || machine === 'arm64'
        ? 'linux-arm64'
        : null;
  if (!architecture) return null;

  return /musl/i.test(probe.libc) ? (`${architecture}-musl` as LinuxPlatformId) : architecture;
}

export function releaseArchiveName(version: string, platformId: LinuxPlatformId): string {
  return `mangostudio-${version}-${platformId}.tar.gz`;
}

export function releaseAssetUrl(version: string, assetName: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${assetName}`;
}

/**
 * Reads one asset's digest out of the release `SHA256SUMS`. Entries may carry a
 * `*` binary marker before the filename, which `sha256sum` writes and ignores.
 */
export function findReleaseChecksum(checksums: string, assetName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const [digest, ...rest] = line.trim().split(/\s+/);
    if (!digest || !/^[a-f0-9]{64}$/i.test(digest)) continue;
    const name = rest.join(' ').replace(/^\*/, '');
    if (name === assetName) return digest.toLowerCase();
  }
  return null;
}
