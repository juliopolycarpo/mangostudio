// The cargo-built `mangostudio-runtime` as a distribution input: which Rust
// target each release platform maps to, where a prebuilt binary is expected,
// when the local machine may build one itself, and what a staged binary must
// look like before it ships beside the hub. Dependency-free: the runtime build
// legs run `scripts/build-runtime.ts` with `bun --no-install`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compareDottedVersions,
  type ExecutableArch,
  type ExecutableFormat,
  type ExecutableHeader,
  readExecutableHeader,
} from './executable-header';
import {
  ALL_BINARY_TARGETS,
  type BinaryTarget,
  type ReleasePlatformId,
  type ReleaseRuntimeBinaryName,
  runtimeBinaryName,
} from './release-targets';

/** The cargo package (and binary) that ships as `mangostudio-runtime[.exe]`. */
const RUNTIME_CARGO_PACKAGE = 'mangostudio-runtime';

/**
 * Compile-time variable the runtime reads through `option_env!` to report the
 * distribution's release version instead of its manifest version.
 */
export const RUNTIME_RELEASE_VERSION_ENV = 'MANGOSTUDIO_RELEASE_VERSION';

/**
 * Oldest glibc a released `linux-x64`/`linux-arm64` runtime may require. The
 * Bun-compiled hub beside it already needs `GLIBC_2.17` (its highest versioned
 * symbol), so a runtime linked against the same floor adds no new requirement
 * to the pair. cargo-zigbuild pins it through the `<triple>.2.17` suffix.
 */
export const GLIBC_FLOOR = '2.17';

type RuntimeOs = 'linux' | 'darwin' | 'windows';

const RUNTIME_OS_VALUES: readonly RuntimeOs[] = ['linux', 'darwin', 'windows'];

interface RuntimeTargetSpec {
  /** Rust target triple, without any cargo-zigbuild glibc suffix. */
  readonly triple: string;
  readonly os: RuntimeOs;
  readonly arch: ExecutableArch;
  /** Linux only: which C library the binary links. */
  readonly libc?: 'gnu' | 'musl';
}

const RUNTIME_TARGETS: Readonly<Record<ReleasePlatformId, RuntimeTargetSpec>> = {
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', os: 'linux', arch: 'x64', libc: 'gnu' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', os: 'linux', arch: 'arm64', libc: 'gnu' },
  'linux-x64-musl': {
    triple: 'x86_64-unknown-linux-musl',
    os: 'linux',
    arch: 'x64',
    libc: 'musl',
  },
  'linux-arm64-musl': {
    triple: 'aarch64-unknown-linux-musl',
    os: 'linux',
    arch: 'arm64',
    libc: 'musl',
  },
  'darwin-x64': { triple: 'x86_64-apple-darwin', os: 'darwin', arch: 'x64' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', os: 'darwin', arch: 'arm64' },
  'windows-x64': { triple: 'x86_64-pc-windows-msvc', os: 'windows', arch: 'x64' },
  'windows-arm64': { triple: 'aarch64-pc-windows-msvc', os: 'windows', arch: 'arm64' },
};

const FORMAT_BY_OS: Readonly<Record<RuntimeOs, ExecutableFormat>> = {
  linux: 'elf',
  darwin: 'macho',
  windows: 'pe',
};

/**
 * DLLs that ship only with the Visual C++ Redistributable, not with Windows:
 * a runtime importing one dies with STATUS_DLL_NOT_FOUND on a machine that
 * never installed it. The CRT is linked statically instead (`.cargo/config.toml`).
 */
const MSVC_REDIST_DLL = /^(?:vcruntime|msvcp)\d.*\.dll$/i;

/** The glibc dynamic loader each gnu target must name as its `PT_INTERP`. */
const GLIBC_LOADER: Readonly<Record<ExecutableArch, string>> = {
  x64: '/lib64/ld-linux-x86-64.so.2',
  arm64: '/lib/ld-linux-aarch64.so.1',
};

/**
 * The Rust target triple a release platform builds for.
 *
 * @example
 * rustTargetTriple('linux-arm64-musl'); // → 'aarch64-unknown-linux-musl'
 */
export function rustTargetTriple(platform: ReleasePlatformId): string {
  return RUNTIME_TARGETS[platform].triple;
}

/**
 * The operating system a release platform's runtime runs on.
 *
 * @example
 * runtimeTargetOs('windows-arm64'); // → 'windows'
 */
function runtimeTargetOs(platform: ReleasePlatformId): RuntimeOs {
  return RUNTIME_TARGETS[platform].os;
}

/**
 * The cargo invocation that builds one platform's runtime. With `zig`, gnu
 * targets link through cargo-zigbuild against {@link GLIBC_FLOOR} and musl
 * targets use zig as their C toolchain; other targets ignore the flag.
 *
 * @example
 * cargoRuntimeBuildCommand('linux-x64', { zig: true });
 * // → ['cargo', 'zigbuild', '--release', '--locked', '-p', 'mangostudio-runtime',
 * //    '--target', 'x86_64-unknown-linux-gnu.2.17']
 */
export function cargoRuntimeBuildCommand(
  platform: ReleasePlatformId,
  options: { readonly zig: boolean }
): string[] {
  const spec = RUNTIME_TARGETS[platform];
  const zig = options.zig && spec.os === 'linux';
  const target = zig && spec.libc === 'gnu' ? `${spec.triple}.${GLIBC_FLOOR}` : spec.triple;
  return [
    'cargo',
    zig ? 'zigbuild' : 'build',
    '--release',
    '--locked',
    '-p',
    RUNTIME_CARGO_PACKAGE,
    '--target',
    target,
  ];
}

/**
 * Where cargo leaves one platform's release runtime. cargo-zigbuild strips the
 * glibc suffix, so both builders share this path.
 *
 * @example
 * cargoRuntimeOutputPath('/repo/target', ALL_BINARY_TARGETS[0]);
 * // → '/repo/target/x86_64-unknown-linux-gnu/release/mangostudio-runtime'
 */
export function cargoRuntimeOutputPath(targetDir: string, target: BinaryTarget): string {
  return join(targetDir, rustTargetTriple(target.arch), 'release', runtimeBinaryName(target.name));
}

/**
 * The release platform this machine is, or `null` when no release targets it.
 * Linux hosts are taken to be glibc: the musl platforms are built on purpose,
 * never implied by the machine running the build.
 *
 * @example
 * hostPlatformId('darwin', 'arm64'); // → 'darwin-arm64'
 */
export function hostPlatformId(
  platform: string = process.platform,
  arch: string = process.arch
): ReleasePlatformId | null {
  const os = platform === 'win32' ? 'windows' : platform;
  if (os !== 'linux' && os !== 'darwin' && os !== 'windows') return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  return `${os}-${arch}`;
}

/**
 * The file a runtime directory must hold for one target:
 * `<dir>/<platform-id>/mangostudio-runtime[.exe]`.
 *
 * @example
 * prebuiltRuntimePath('.mango/runtime', windowsX64); // → '.mango/runtime/windows-x64/mangostudio-runtime.exe'
 */
export function prebuiltRuntimePath(runtimeDir: string, target: BinaryTarget): string {
  return join(runtimeDir, target.arch, runtimeBinaryName(target.name));
}

export type RuntimeSource =
  | { readonly kind: 'prebuilt'; readonly path: string }
  | { readonly kind: 'cargo'; readonly command: readonly string[] };

export interface ResolveRuntimeSourceOptions {
  readonly target: BinaryTarget;
  /** Directory of prebuilt runtimes; authoritative for every target when set. */
  readonly runtimeDir?: string;
  readonly hostPlatform: ReleasePlatformId | null;
  readonly fileExists?: (path: string) => boolean;
}

/**
 * Decide where one target's runtime comes from. A runtime directory, when
 * given, is the only source — a missing file there is an error, never a
 * reason to build something else. Without one, only the host's own target is
 * built, with plain `cargo build`; every other target is an error that names
 * the file and layout it expected. There is no fallback to any other runtime.
 *
 * @example
 * resolveRuntimeSource({ target, hostPlatform: 'linux-x64' });
 * // → { kind: 'cargo', command: ['cargo', 'build', …, '--target', 'x86_64-unknown-linux-gnu'] }
 */
export function resolveRuntimeSource(options: ResolveRuntimeSourceOptions): RuntimeSource {
  const { target, runtimeDir, hostPlatform } = options;
  const fileExists = options.fileExists ?? existsSync;
  const name: ReleaseRuntimeBinaryName = runtimeBinaryName(target.name);

  if (runtimeDir) {
    const path = prebuiltRuntimePath(runtimeDir, target);
    if (fileExists(path)) return { kind: 'prebuilt', path };
    throw new Error(
      `Missing prebuilt runtime for ${target.arch}: expected ${path}. ` +
        `A runtime directory holds <dir>/<platform-id>/${name} for every requested target; build it with ` +
        `\`bun run build:runtime --platform ${target.arch} --out ${runtimeDir}\`.`
    );
  }

  if (target.arch === hostPlatform) {
    return { kind: 'cargo', command: cargoRuntimeBuildCommand(target.arch, { zig: false }) };
  }

  throw new Error(
    `No runtime binary for ${target.arch}: this machine (${hostPlatform ?? 'unsupported host'}) only ` +
      `cargo-builds its own target. Pass --runtime-dir <dir> (or RUNTIME_DIR) where ` +
      `<dir>/${target.arch}/${name} is a prebuilt runtime, e.g. from ` +
      `\`bun run build:runtime --platform ${target.arch} --out <dir>\`.`
  );
}

/**
 * Whether this machine can execute a target's runtime to ask its version. A
 * static musl runtime runs on any Linux host of the same CPU.
 *
 * @example
 * canRunOnHost('linux-x64-musl', 'linux-x64'); // → true
 */
export function canRunOnHost(
  platform: ReleasePlatformId,
  hostPlatform: ReleasePlatformId | null
): boolean {
  if (!hostPlatform) return false;
  const target = RUNTIME_TARGETS[platform];
  const host = RUNTIME_TARGETS[hostPlatform];
  return target.os === host.os && target.arch === host.arch;
}

/**
 * Everything wrong with a runtime's header for a target, or `[]`. Checks the
 * container format and CPU, that a gnu build asks for the glibc loader and a
 * musl build is static, that a Windows build imports no Visual C++
 * Redistributable DLL, and — when `enforceGlibcFloor` — that a gnu build
 * needs nothing newer than {@link GLIBC_FLOOR}.
 *
 * @example
 * runtimeHeaderProblems('linux-arm64', header, { enforceGlibcFloor: true }); // → []
 */
export function runtimeHeaderProblems(
  platform: ReleasePlatformId,
  header: ExecutableHeader,
  options: { readonly enforceGlibcFloor: boolean }
): string[] {
  const spec = RUNTIME_TARGETS[platform];
  const expectedFormat = FORMAT_BY_OS[spec.os];
  const problems: string[] = [];
  if (header.format !== expectedFormat || header.arch !== spec.arch) {
    problems.push(
      `expected ${expectedFormat} ${spec.arch} | received: ${header.format} ${header.arch}`
    );
  }
  if (spec.libc === 'musl' && header.interpreter !== null) {
    problems.push(
      `expected a static musl executable (no PT_INTERP) | received interpreter: ${header.interpreter}`
    );
  }
  if (spec.libc === 'gnu' && header.interpreter !== GLIBC_LOADER[spec.arch]) {
    problems.push(
      `expected glibc loader ${GLIBC_LOADER[spec.arch]} | received: ${header.interpreter ?? 'none (static)'}`
    );
  }
  const redistributable = header.dllImports.filter((dll) => MSVC_REDIST_DLL.test(dll));
  if (redistributable.length > 0) {
    problems.push(
      `expected no Visual C++ Redistributable imports (link with +crt-static) | received: ${redistributable.join(', ')}`
    );
  }
  if (
    spec.libc === 'gnu' &&
    options.enforceGlibcFloor &&
    header.maxGlibc &&
    compareDottedVersions(header.maxGlibc, GLIBC_FLOOR) > 0
  ) {
    problems.push(
      `expected no symbol newer than GLIBC_${GLIBC_FLOOR} | received: GLIBC_${header.maxGlibc}`
    );
  }
  return problems;
}

/**
 * Compare a runtime's `--version` output with the release it must report.
 * Returns the mismatch, or `null` when it matches.
 *
 * @example
 * runtimeVersionProblem('0.1.1\n', '0.1.1'); // → null
 */
export function runtimeVersionProblem(stdout: string, expected: string): string | null {
  const reported = stdout.trim();
  return reported === expected
    ? null
    : `expected --version: ${expected} | received: ${reported || '(empty)'}`;
}

export interface RuntimeVerification {
  /** `null` when the file is not a recognisable executable at all. */
  readonly header: ExecutableHeader | null;
  /** `null` when the runtime cannot run on this machine. */
  readonly reportedVersion: string | null;
  readonly problems: readonly string[];
}

export interface VerifyRuntimeBinaryOptions {
  readonly path: string;
  readonly target: BinaryTarget;
  readonly version: string;
  readonly hostPlatform: ReleasePlatformId | null;
  readonly enforceGlibcFloor: boolean;
}

/**
 * Check a staged runtime from its bytes, and — when this machine can run it —
 * that it reports the release version. Never throws for a wrong binary: the
 * caller decides how to report `problems`.
 *
 * @example
 * const { problems } = await verifyRuntimeBinary({ path, target, version: '0.1.1', hostPlatform: 'linux-x64', enforceGlibcFloor: true });
 */
export async function verifyRuntimeBinary(
  options: VerifyRuntimeBinaryOptions
): Promise<RuntimeVerification> {
  const { path, target, version, hostPlatform, enforceGlibcFloor } = options;
  let header: ExecutableHeader;
  try {
    header = readExecutableHeader(readFileSync(path));
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return { header: null, reportedVersion: null, problems: [`${path}: ${reason}`] };
  }

  const problems = runtimeHeaderProblems(target.arch, header, { enforceGlibcFloor }).map(
    (problem) => `${path}: ${problem}`
  );
  if (!canRunOnHost(target.arch, hostPlatform)) {
    return { header, reportedVersion: null, problems };
  }

  const child = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    problems.push(`${path}: expected --version to exit 0 | received: ${exitCode} ${stderr.trim()}`);
  } else {
    const versionProblem = runtimeVersionProblem(stdout, version);
    if (versionProblem) problems.push(`${path}: ${versionProblem}`);
  }
  return { header, reportedVersion: stdout.trim(), problems };
}

/**
 * Select the release targets named by `--platform` and `--os`. Throws, naming
 * the unknown value and the accepted ones, rather than silently building less.
 *
 * @example
 * selectRuntimeTargets('linux-x64 windows-x64', 'linux'); // → [linux-x64 target]
 */
export function selectRuntimeTargets(
  platforms: string | undefined,
  os: string | undefined
): BinaryTarget[] {
  const requested = (platforms ?? '').split(/[\s,]+/).filter(Boolean);
  const known = ALL_BINARY_TARGETS.map((target) => target.arch as string);
  const unknown = requested.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `expected --platform ids from ${known.join(', ')} | received: ${unknown.join(', ')}`
    );
  }
  if (os !== undefined && !RUNTIME_OS_VALUES.includes(os as RuntimeOs)) {
    throw new Error(`expected --os ${RUNTIME_OS_VALUES.join(' | ')} | received: ${os}`);
  }
  return ALL_BINARY_TARGETS.filter(
    (target) =>
      (requested.length === 0 || requested.includes(target.arch)) &&
      (os === undefined || runtimeTargetOs(target.arch) === os)
  );
}
