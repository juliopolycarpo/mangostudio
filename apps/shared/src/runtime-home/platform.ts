/**
 * Maps a remote `uname`/`ldd` probe to a release platform id.
 *
 * WSL always lands on a Linux id via {@link resolveLinuxPlatformId}; SSH and
 * copyable one-liners need the full posix set, including Darwin, so a macOS
 * host is not handed a Linux binary.
 */

export type LinuxPlatformId = 'linux-x64' | 'linux-arm64' | 'linux-x64-musl' | 'linux-arm64-musl';

export type DarwinPlatformId = 'darwin-x64' | 'darwin-arm64';

/** Posix release arches the hub can push over WSL or SSH. */
export type RuntimePlatformId = LinuxPlatformId | DarwinPlatformId;

export interface RuntimePlatformProbe {
  /** `uname -s` — Linux, Darwin, … */
  readonly kernel: string;
  /** `uname -m`. */
  readonly machine: string;
  /** First line of `ldd --version` (empty / non-musl on Darwin). */
  readonly libc: string;
}

/**
 * Reports kernel, machine, and libc in one round trip, in the order
 * {@link RuntimePlatformProbe} reads them.
 *
 * It lives beside the parser because a probe and the thing that interprets its
 * output are one contract: WSL, SSH and container targets all answer this exact
 * script, and a second copy would drift the day one of them needed another
 * line. Alpine is a real target on all three and needs the musl build, which
 * `uname -m` alone cannot distinguish from glibc; `uname -s` is what keeps a
 * macOS SSH host from being handed a Linux binary.
 */
export const PLATFORM_PROBE_SCRIPT = 'uname -s; uname -m; (ldd --version 2>&1 || true) | head -n 1';

/** The most of a probe's own output any refusal repeats back. */
const MAX_RAW_PROBE_CHARS = 200;

/**
 * What {@link parsePlatformProbe} made of a probe's output.
 *
 * A discriminated result rather than a partly-filled probe: every field of
 * {@link RuntimePlatformProbe} has to come from the line it was read from, and
 * an object with a guessed `kernel` in it is indistinguishable downstream from
 * one a host actually reported.
 */
export type PlatformProbeResult =
  | ({ readonly ok: true } & RuntimePlatformProbe)
  | {
      readonly ok: false;
      readonly reason: 'unexpected-shape';
      /** The output itself, on one bounded line, for a refusal to quote. */
      readonly raw: string;
    };

/**
 * Reads {@link PLATFORM_PROBE_SCRIPT}'s output, for every transport that runs
 * it.
 *
 * It lives here because the script does: the hub sends this exact text and
 * reads back what it produced, so there is no version skew to tolerate and no
 * second shape to guess at. A caller that guessed one — reading a two-line
 * answer as machine-and-libc with the kernel assumed to be `Linux` — misread
 * `uname -s` as the machine on every host whose `ldd` writes nothing, which is
 * how a silent `ldd` produces two lines in the first place.
 *
 * Tolerated, because they say nothing about the shape: `\r\n`, blank lines
 * before or after the answer, and a missing final line from an `ldd` that
 * printed nothing. Extra lines past the third are ignored the way a login
 * banner has to be. Anything with fewer than two lines is reported rather than
 * completed from a guess — a confidently wrong platform is worse than a
 * failure that quotes what the host actually said.
 */
export function parsePlatformProbe(stdout: string): PlatformProbeResult {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const [kernel, machine, libc = ''] = lines;
  if (!kernel || !machine) {
    const raw = lines.join(' / ');
    return {
      ok: false,
      reason: 'unexpected-shape',
      raw: raw.length > MAX_RAW_PROBE_CHARS ? `${raw.slice(0, MAX_RAW_PROBE_CHARS)}…` : raw,
    };
  }
  return { ok: true, kernel, machine, libc };
}

function architectureSuffix(machine: string): 'x64' | 'arm64' | null {
  const normalized = machine.trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64') return 'x64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  return null;
}

/**
 * Resolves the six posix release ids. Returns null for Windows probes and
 * unknown arches — those are not push targets this cycle.
 */
export function resolveRuntimePlatformId(probe: RuntimePlatformProbe): RuntimePlatformId | null {
  const kernel = probe.kernel.trim().toLowerCase();
  const arch = architectureSuffix(probe.machine);
  if (!arch) return null;

  if (kernel === 'linux') {
    const base = `linux-${arch}` as const;
    return /musl/i.test(probe.libc) ? (`${base}-musl` as LinuxPlatformId) : base;
  }
  if (kernel === 'darwin') {
    return `darwin-${arch}` as DarwinPlatformId;
  }
  return null;
}

/**
 * Narrowing for WSL: only Linux ids. Ignores kernel because a WSL distribution
 * is always Linux even if the probe script grows a `uname -s` line.
 */
export function resolveLinuxPlatformId(
  probe: Pick<RuntimePlatformProbe, 'machine' | 'libc'>
): LinuxPlatformId | null {
  const resolved = resolveRuntimePlatformId({
    kernel: 'Linux',
    machine: probe.machine,
    libc: probe.libc,
  });
  if (!resolved?.startsWith('linux-')) return null;
  return resolved as LinuxPlatformId;
}

/** Every posix id the release plan publishes beside Windows. */
export const RUNTIME_PLATFORM_IDS: readonly RuntimePlatformId[] = [
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
];
