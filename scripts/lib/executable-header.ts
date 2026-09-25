// Reads just enough of an executable's header to say what machine it was built
// for. The release pipeline stages eight runtime binaries it can mostly not run
// (a macOS or Windows runtime on a Linux packaging runner), so "the file under
// `darwin-arm64/` is a darwin-arm64 executable" has to be checked from its
// bytes, not trusted from its path. Dependency-free on purpose: the runtime
// build legs run it with `bun --no-install`.

export type ExecutableFormat = 'elf' | 'macho' | 'pe';
export type ExecutableArch = 'x64' | 'arm64';

export interface ExecutableHeader {
  readonly format: ExecutableFormat;
  readonly arch: ExecutableArch;
  /** ELF only: the `PT_INTERP` loader path, or `null` for a static executable. */
  readonly interpreter: string | null;
  /** ELF only: the highest `GLIBC_x.y` symbol version the file names, or `null`. */
  readonly maxGlibc: string | null;
}

const ELF_MACHINES: Readonly<Record<number, ExecutableArch>> = { 62: 'x64', 183: 'arm64' };
const MACHO_CPU_TYPES: Readonly<Record<number, ExecutableArch>> = {
  16777223: 'x64',
  16777228: 'arm64',
};
const PE_MACHINES: Readonly<Record<number, ExecutableArch>> = { 34404: 'x64', 43620: 'arm64' };

const PT_INTERP = 3;
const MACHO_MAGIC_64 = 0xfeed_facf;
const PE32_PLUS_MAGIC = 0x20b;
const GLIBC_VERSION_RE = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g;

/**
 * Identify a 64-bit little-endian ELF, Mach-O, or PE32+ executable and its
 * CPU. Throws, naming what was found and what is accepted, for anything else —
 * a script, a 32-bit or big-endian build, a universal Mach-O, or an unknown CPU.
 *
 * @example
 * const header = readExecutableHeader(new Uint8Array(await Bun.file(path).arrayBuffer()));
 * // → { format: 'elf', arch: 'x64', interpreter: '/lib64/ld-linux-x86-64.so.2', maxGlibc: '2.17' }
 */
export function readExecutableHeader(bytes: Uint8Array): ExecutableHeader {
  if (bytes.length < 64) {
    throw new Error(
      `expected an executable of at least 64 bytes (ELF, Mach-O, or PE32+) | received: ${bytes.length} bytes`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, false) === 0x7f45_4c46) return readElf(bytes, view);
  if (view.getUint32(0, true) === MACHO_MAGIC_64) return readMachO(view);
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return readPe(view);

  throw new Error(
    `expected an ELF, Mach-O (64-bit), or PE executable | received magic bytes: ${hex(bytes.subarray(0, 4))}`
  );
}

function readElf(bytes: Uint8Array, view: DataView): ExecutableHeader {
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error(
      `expected a 64-bit little-endian ELF (EI_CLASS=2, EI_DATA=1) | received: EI_CLASS=${bytes[4]}, EI_DATA=${bytes[5]}`
    );
  }
  const machine = view.getUint16(18, true);
  const arch = ELF_MACHINES[machine];
  if (!arch) {
    throw new Error(
      `expected ELF e_machine x86-64 (0x3e) or aarch64 (0xb7) | received: 0x${machine.toString(16)}`
    );
  }
  return {
    format: 'elf',
    arch,
    interpreter: readElfInterpreter(bytes, view),
    maxGlibc: maxGlibcVersion(bytes),
  };
}

function readElfInterpreter(bytes: Uint8Array, view: DataView): string | null {
  const phoff = Number(view.getBigUint64(32, true));
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  for (let index = 0; index < phnum; index += 1) {
    const entry = phoff + index * phentsize;
    if (entry + 40 > bytes.length || view.getUint32(entry, true) !== PT_INTERP) continue;
    const offset = Number(view.getBigUint64(entry + 8, true));
    const size = Number(view.getBigUint64(entry + 32, true));
    const raw = bytes.subarray(offset, offset + size);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
  }
  return null;
}

/**
 * The highest `GLIBC_x.y` version string anywhere in the file. The versioned
 * symbol requirements live in `.dynstr`; scanning the whole file is cheaper
 * than walking `.gnu.version_r` and can only over-report, never under-report,
 * which is the safe side for a floor check.
 */
function maxGlibcVersion(bytes: Uint8Array): string | null {
  const text = new TextDecoder('latin1').decode(bytes);
  let best: number[] | null = null;
  for (const match of text.matchAll(GLIBC_VERSION_RE)) {
    const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    if (!best || compareVersionParts(parts, best) > 0) best = parts;
  }
  if (!best) return null;
  return best[2] === 0 ? `${best[0]}.${best[1]}` : best.join('.');
}

function readMachO(view: DataView): ExecutableHeader {
  const cpuType = view.getUint32(4, true);
  const arch = MACHO_CPU_TYPES[cpuType];
  if (!arch) {
    throw new Error(
      `expected Mach-O cputype x86_64 (0x01000007) or arm64 (0x0100000c) | received: 0x${cpuType.toString(16)}`
    );
  }
  return { format: 'macho', arch, interpreter: null, maxGlibc: null };
}

function readPe(view: DataView): ExecutableHeader {
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 26 > view.byteLength || view.getUint32(peOffset, false) !== 0x5045_0000) {
    throw new Error(
      `expected a "PE\\0\\0" signature at e_lfanew | received offset 0x${peOffset.toString(16)} without one`
    );
  }
  const machine = view.getUint16(peOffset + 4, true);
  const arch = PE_MACHINES[machine];
  if (!arch) {
    throw new Error(
      `expected PE machine AMD64 (0x8664) or ARM64 (0xaa64) | received: 0x${machine.toString(16)}`
    );
  }
  const optionalMagic = view.getUint16(peOffset + 24, true);
  if (optionalMagic !== PE32_PLUS_MAGIC) {
    throw new Error(
      `expected a PE32+ optional header (magic 0x20b) | received: 0x${optionalMagic.toString(16)}`
    );
  }
  return { format: 'pe', arch, interpreter: null, maxGlibc: null };
}

/**
 * Compare two dotted versions numerically (`'2.17'` vs `'2.9'`).
 *
 * @example
 * compareDottedVersions('2.28', '2.17'); // → 1
 */
export function compareDottedVersions(left: string, right: string): number {
  return compareVersionParts(left.split('.').map(Number), right.split('.').map(Number));
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}
