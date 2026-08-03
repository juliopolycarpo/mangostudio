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
import {
  mangoHomeDir,
  RUNTIME_BINARY_BASENAME,
  RUNTIME_CONFIG_FILE_NAME,
  RUNTIME_CONFIG_LOCK_FILE_NAME,
  RUNTIME_CURRENT_LINK_NAME,
  type RuntimeSlotConfig,
  RuntimeSlotConfigSchema,
  runtimeSlotCurrentBinaryPath,
  runtimeSlotDir,
  runtimeSlotVersionBinaryPath,
} from '@mangostudio/shared/runtime-home';
import { Value } from '@sinclair/typebox/value';
import type { RuntimeLaunchCommand } from '../../../lib/runtime-paths';

const REPOSITORY = 'juliopolycarpo/mangostudio';

const RUNTIME_ARCHIVE_MEMBER = RUNTIME_BINARY_BASENAME;

/**
 * A path inside the distribution's `wsl` slot, quoted for its own shell.
 *
 * `$HOME` is expanded there rather than here: the hub does not know where a
 * distribution's home directory is, and `wsl.exe --exec` performs no expansion.
 * The layout comes from the shared runtime home, so the directory an install
 * writes into and the one a launcher reads from cannot drift.
 */
function distroPath(...segments: readonly string[]): string {
  return `"${[runtimeSlotDir('wsl', { mangoHome: mangoHomeDir('$HOME') }), ...segments].join('/')}"`;
}

/** Where the runtime ends up, written the way someone would type it. */
export const DISTRO_RUNTIME_PATH = runtimeSlotCurrentBinaryPath('wsl', {
  mangoHome: mangoHomeDir('~'),
});

/** The unversioned binary #771 shipped, kept only so it can be removed. */
export const LEGACY_DISTRO_RUNTIME_PATH = '~/.mango/bin/mangostudio-runtime';

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

/** `$1` is the version, supplied as an argv entry rather than spliced in. */
const VERSION_DIR = distroPath('$1');
const LIVE_PATH = distroPath('$1', RUNTIME_ARCHIVE_MEMBER);
const STAGED_PATH = distroPath('$1', `${RUNTIME_ARCHIVE_MEMBER}.incoming`);
const CURRENT_LINK = distroPath(RUNTIME_CURRENT_LINK_NAME);
const CURRENT_BINARY = distroPath(RUNTIME_CURRENT_LINK_NAME, RUNTIME_ARCHIVE_MEMBER);
const CONFIG_PATH = distroPath(RUNTIME_CONFIG_FILE_NAME);
const STAGED_CONFIG_PATH = distroPath(`${RUNTIME_CONFIG_FILE_NAME}.incoming`);
const CONFIG_LOCK_PATH = distroPath(RUNTIME_CONFIG_LOCK_FILE_NAME);

/**
 * Stages whatever `stage` writes from stdin, then publishes it with a rename
 * and points `current` at the version it belongs to.
 *
 * The version arrives as `$1` — an argv entry, never text spliced into this
 * string. Every script in this module is a constant for that reason.
 *
 * The rename is the point. A distribution can already be running a runtime when
 * it is provisioned again — a hub update drifts the version of every
 * distribution at once, and the second environment to reconnect reinstalls
 * while the first is still connected. Writing straight onto the live path would
 * open the file that process is executing from, which Linux refuses with
 * `ETXTBSY`, failing the install over something the user cannot act on.
 * Replacing the directory entry instead leaves the running process on the inode
 * it started with and gives the next launch the new binary.
 *
 * `current` is what keeps an ssh argument and a service unit's `ExecStart` from
 * embedding a version that dangles after the next upgrade. GNU `ln -sfn`
 * publishes it by creating a temporary link and renaming it over the old one,
 * so a launch never sees the link missing. Busybox's `ln` unlinks first and
 * leaves a window instead; a launch landing inside it reads as a runtime that
 * is not there, which retries away.
 */
function installScript(stage: string): string {
  return (
    'set -e; ' +
    `mkdir -p ${VERSION_DIR}; ` +
    `${stage}; ` +
    `chmod +x ${STAGED_PATH}; ` +
    `mv -f ${STAGED_PATH} ${LIVE_PATH}; ` +
    `ln -sfn "$1" ${CURRENT_LINK}`
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
const LAUNCH_SCRIPT = `exec ${CURRENT_BINARY} "$@"`;

/** Reports the installed runtime's version, and fails when there is not one. */
export const VERSION_SCRIPT = `exec ${CURRENT_BINARY} --version`;

/**
 * Records the consent a distribution gets by being one.
 *
 * A WSL distribution is this machine, reached sideways — the account that runs
 * the hub is the account that runs the runtime — so 010's one-click connect
 * stays one click. It goes through the runtime's own `setup` rather than the
 * hub writing an `allow` block itself, so there is exactly one thing in the
 * system that authors consent. It runs on the first provision only; an upgrade
 * replaces bytes and leaves the answer alone.
 */
export const SETUP_FULL_SCRIPT = `exec ${CURRENT_BINARY} setup --profile full --yes`;

/**
 * Reports where the distribution's home directory is and what it recorded about
 * its own runtime — the home on the first line, the config on the rest.
 *
 * Both in one round trip because both are needed together and neither is worth
 * a spawn of its own. The digest is read rather than recomputed: hashing the
 * installed binary inside the distribution on every connect would make the
 * cheapest check the most expensive one, and the hub pushed those bytes, so it
 * already knows what their digest is.
 *
 * A `cat` that fails says so, because silence here means something specific.
 * No config resolves to "nobody has answered yet", which is what lets the first
 * provision record full consent; a config the hub cannot read may have narrowed
 * this distribution, and reporting it as absent would hand back everything it
 * took away. The marker is deliberately not JSON, so a partial read that dies
 * mid-file lands on the same answer.
 */
const CONFIG_UNREADABLE_MARKER = '<runtime.json unreadable>';
export const PROBE_SLOT_SCRIPT =
  `printf '%s\\n' "$HOME"; ` +
  `cat ${CONFIG_PATH} 2>/dev/null || ` +
  `{ [ -e ${CONFIG_PATH} ] && printf '%s\\n' '${CONFIG_UNREADABLE_MARKER}'; }; ` +
  'true';

/** What a distribution answered {@link PROBE_SLOT_SCRIPT} with. */
export interface DistroSlotProbe {
  /** The distribution's `$HOME`, which no hub can guess. */
  readonly home: string;
  /** Its `runtime.json`, or null when there is none or it could not be read. */
  readonly config: RuntimeSlotConfig | null;
  /**
   * True when a file was there and this hub could not read it, which is not the
   * same as there being none. The install facts recover by being rewritten, but
   * consent does not: the unreadable file may have narrowed this distribution,
   * and an unknown answer must never resolve to yes.
   */
  readonly unreadable: boolean;
}

export function parseDistroSlotProbe(stdout: string): DistroSlotProbe {
  const newline = stdout.indexOf('\n');
  const home = (newline === -1 ? stdout : stdout.slice(0, newline)).trim();
  const rest = newline === -1 ? '' : stdout.slice(newline + 1).trim();
  if (!rest) return { home, config: null, unreadable: false };
  if (rest === CONFIG_UNREADABLE_MARKER) return { home, config: null, unreadable: true };

  try {
    const parsed: unknown = JSON.parse(rest);
    return Value.Check(RuntimeSlotConfigSchema, parsed)
      ? { home, config: parsed, unreadable: false }
      : { home, config: null, unreadable: true };
  } catch {
    return { home, config: null, unreadable: true };
  }
}

/**
 * What the distribution's `runtime.json` should say after this install.
 *
 * The hub owns the install facts — which version it pushed, the digest of the
 * bytes it sent, and which hub sent them — and touches nothing else. Consent is
 * not in that list on purpose: upgrades replace bytes, never the answer
 * somebody gave about what a hub may do here. `setup` writes that, once, on the
 * first provision.
 *
 * `armGate` is the exception, and it is a refusal rather than an answer. A
 * config this hub could not read may have narrowed the distribution, so the
 * rewrite leaves the gate closed and somebody at the machine re-answers.
 */
export function distroRuntimeConfigAfterInstall(params: {
  readonly stored: RuntimeSlotConfig | null;
  readonly home: string;
  readonly version: string;
  readonly digest: string;
  readonly hubVersion: string;
  readonly hubHost: string;
  readonly at: string;
  readonly armGate?: boolean;
}): RuntimeSlotConfig {
  return {
    ...params.stored,
    schemaVersion: 1,
    slot: 'wsl',
    source: 'provisioned',
    version: params.version,
    binaryPath: runtimeSlotVersionBinaryPath('wsl', params.version, {
      mangoHome: mangoHomeDir(params.home),
    }),
    digest: params.digest,
    installedBy: {
      hubVersion: params.hubVersion,
      host: params.hubHost,
      transport: 'wsl',
      at: params.at,
    },
    ...(params.armGate ? { setup: { state: 'pending', at: params.at, by: 'install' } } : {}),
  };
}

/** Exit status when the slot lock could not be taken. `EX_TEMPFAIL`. */
export const CONFIG_LOCK_BUSY_EXIT = 75;

/**
 * Replaces the distribution's `runtime.json` with whatever arrives on stdin,
 * holding the same lock the runtime's own writers take.
 *
 * The document is JSON the hub built and serialized, piped in rather than
 * interpolated: a version string, a digest, and a host name have no business
 * being parsed by a shell.
 *
 * The lock is the point. This is the one writer of that file that is not the
 * runtime, and the document it writes carries consent forward from a read the
 * hub did earlier. A `setup` inside the distribution that lands between them
 * completes under the runtime's lock and would then be overwritten by an answer
 * taken before it ran. `set -C` is how POSIX sh spells an exclusive create, and
 * the owner written into the lock is the same shape the runtime writes, so
 * whichever side finds a lock left by a killed process can reclaim it.
 *
 * `trap … EXIT` releases it on every path out, including the ones that fail.
 */
export const WRITE_CONFIG_SCRIPT =
  'set -e; ' +
  `mkdir -p ${distroPath()}; ` +
  'attempt=0; ' +
  `until (set -C; : > ${CONFIG_LOCK_PATH}) 2>/dev/null; do ` +
  'attempt=$((attempt+1)); ' +
  `if [ "$attempt" -ge 10 ]; then exit ${CONFIG_LOCK_BUSY_EXIT}; fi; ` +
  'sleep 1; ' +
  'done; ' +
  `trap 'rm -f ${CONFIG_LOCK_PATH}' EXIT INT TERM HUP; ` +
  `printf '{"pid":%s,"host":"%s"}' "$$" "$(uname -n)" > ${CONFIG_LOCK_PATH}; ` +
  `cat > ${STAGED_CONFIG_PATH}; ` +
  `mv -f ${STAGED_CONFIG_PATH} ${CONFIG_PATH}`;

/**
 * Removes the unversioned binary #771 left at `~/.mango/bin`, and says whether
 * there was one.
 *
 * Two runtimes in one distribution guarantee somebody debugs the wrong one. The
 * directory goes too when nothing else is in it; `rmdir` failing on a directory
 * with other contents is not an error worth propagating.
 */
export const REMOVE_LEGACY_RUNTIME_SCRIPT =
  'if [ -e "$HOME/.mango/bin/mangostudio-runtime" ]; then ' +
  'rm -f "$HOME/.mango/bin/mangostudio-runtime"; ' +
  'rmdir "$HOME/.mango/bin" 2>/dev/null || true; ' +
  'echo removed; fi';

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
