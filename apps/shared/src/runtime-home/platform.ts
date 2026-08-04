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
