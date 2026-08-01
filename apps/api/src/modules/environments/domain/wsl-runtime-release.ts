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

import { join } from 'node:path';
import type { RuntimeLaunchCommand } from '../../../lib/runtime-paths';

const REPOSITORY = 'juliopolycarpo/mangostudio';

/** Where the runtime lands inside a distribution. */
const DISTRO_RUNTIME_DIR = '.mango/bin';
const RUNTIME_ARCHIVE_MEMBER = 'mangostudio-runtime';
/** Where an incoming runtime is assembled before it takes over the name above. */
const STAGED_ARCHIVE_MEMBER = `${RUNTIME_ARCHIVE_MEMBER}.incoming`;

/** Where the runtime ends up, written the way someone would type it. */
export const DISTRO_RUNTIME_PATH = `~/${DISTRO_RUNTIME_DIR}/${RUNTIME_ARCHIVE_MEMBER}`;

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

const STAGED_PATH = `"$HOME/${DISTRO_RUNTIME_DIR}/${STAGED_ARCHIVE_MEMBER}"`;

/**
 * Stages whatever `stage` writes from stdin, then publishes it with a rename.
 *
 * `$HOME` is expanded by the distribution's own shell: the hub does not know
 * where a distribution's home directory is, and `wsl.exe --exec` performs no
 * expansion.
 *
 * The rename is the point. A distribution can already be running a runtime when
 * it is provisioned again — a hub update drifts the version of every
 * distribution at once, and the second environment to reconnect reinstalls
 * while the first is still connected. Writing straight onto the live path would
 * open the file that process is executing from, which Linux refuses with
 * `ETXTBSY`, failing the install over something the user cannot act on.
 * Replacing the directory entry instead leaves the running process on the inode
 * it started with and gives the next launch the new binary.
 */
function installScript(stage: string): string {
  return (
    'set -e; ' +
    `mkdir -p "$HOME/${DISTRO_RUNTIME_DIR}"; ` +
    `${stage}; ` +
    `chmod +x ${STAGED_PATH}; ` +
    `mv -f ${STAGED_PATH} "$HOME/${DISTRO_RUNTIME_DIR}/${RUNTIME_ARCHIVE_MEMBER}"`
  );
}

/** Unpacks the one member that matters out of a release's platform archive. */
export const INSTALL_ARCHIVE_SCRIPT = installScript(
  `tar -xzf - -O ${RUNTIME_ARCHIVE_MEMBER} > ${STAGED_PATH}`
);

/**
 * Takes the binary whole, which is what a source checkout has to offer: it
 * builds a runtime, not a release archive.
 */
export const INSTALL_BINARY_SCRIPT = installScript(`cat > ${STAGED_PATH}`);

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
 * Where a source checkout keeps the Linux runtime it built for itself — the
 * same layout `bun run build:binary --platform <id>` writes into. A checkout's
 * version names no release, so this is the only place left to look.
 */
export function localRuntimeBuildPath(baseDir: string, platformId: LinuxPlatformId): string {
  return join(baseDir, '.mango', 'out', platformId, RUNTIME_ARCHIVE_MEMBER);
}

/**
 * The command that produces the file above. Compiling without a version stamp
 * is deliberate: the runtime then reports `dev` the same way a checkout's hub
 * does, and the handshake only accepts a runtime whose release matches.
 * // Usage: localRuntimeBuildCommand('linux-x64', 'C:\\repo\\.mango\\out\\...')
 */
export function localRuntimeBuildCommand(platformId: LinuxPlatformId, outfile: string): string {
  return `bun build apps/runtime/src/cli.ts --compile --target=bun-${platformId} --outfile ${outfile}`;
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
