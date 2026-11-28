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
  /** PE only: every DLL the import and delay-import tables name, in table order. */
  readonly dllImports: readonly string[];
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
/** PE32+ data directory indexes: imports and delay-load imports. */
const PE_IMPORT_DIRECTORY = 1;
const PE_DELAY_IMPORT_DIRECTORY = 13;
const PE_IMPORT_DESCRIPTOR_BYTES = 20;
const PE_DELAY_DESCRIPTOR_BYTES = 32;
/** Upper bound on descriptors walked, so a corrupt table cannot loop the reader. */
const PE_MAX_DESCRIPTORS = 4096;

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
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return readPe(bytes, view);

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
    dllImports: [],
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
  return { format: 'macho', arch, interpreter: null, maxGlibc: null, dllImports: [] };
}

function readPe(bytes: Uint8Array, view: DataView): ExecutableHeader {
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
  return {
    format: 'pe',
    arch,
    interpreter: null,
    maxGlibc: null,
    dllImports: readPeDllImports(bytes, view, peOffset),
  };
}

interface PeSection {
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawOffset: number;
  readonly rawSize: number;
}

/**
 * DLL names from the import directory (`IMAGE_IMPORT_DESCRIPTOR.Name`) and the
 * delay-import directory (`ImgDelayDescr.DllNameRVA`). A delay-loaded DLL is
 * still a DLL the process cannot run without once it calls into it.
 */
function readPeDllImports(bytes: Uint8Array, view: DataView, peOffset: number): string[] {
  const optionalOffset = peOffset + 24;
  if (optionalOffset + 112 > view.byteLength) return [];
  const sections = readPeSections(view, peOffset, optionalOffset);
  const directoryCount = view.getUint32(optionalOffset + 108, true);
  const directory = (index: number): number =>
    index < directoryCount ? view.getUint32(optionalOffset + 112 + index * 8, true) : 0;

  return [
    ...readDescriptorNames(bytes, view, sections, directory(PE_IMPORT_DIRECTORY), {
      size: PE_IMPORT_DESCRIPTOR_BYTES,
      nameField: 12,
    }),
    ...readDescriptorNames(bytes, view, sections, directory(PE_DELAY_IMPORT_DIRECTORY), {
      size: PE_DELAY_DESCRIPTOR_BYTES,
      nameField: 4,
    }),
  ];
}

function readPeSections(view: DataView, peOffset: number, optionalOffset: number): PeSection[] {
  const count = view.getUint16(peOffset + 6, true);
  const optionalSize = view.getUint16(peOffset + 20, true);
  const first = optionalOffset + optionalSize;
  const sections: PeSection[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = first + index * 40;
    if (entry + 40 > view.byteLength) break;
    sections.push({
      virtualSize: view.getUint32(entry + 8, true),
      virtualAddress: view.getUint32(entry + 12, true),
      rawSize: view.getUint32(entry + 16, true),
      rawOffset: view.getUint32(entry + 20, true),
    });
  }
  return sections;
}

function rvaToOffset(sections: readonly PeSection[], rva: number): number | null {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawOffset + (rva - section.virtualAddress);
    }
  }
  return null;
}

function readDescriptorNames(
  bytes: Uint8Array,
  view: DataView,
  sections: readonly PeSection[],
  tableRva: number,
  layout: { readonly size: number; readonly nameField: number }
): string[] {
  const table = tableRva === 0 ? null : rvaToOffset(sections, tableRva);
  if (table === null) return [];
  const names: string[] = [];
  for (let index = 0; index < PE_MAX_DESCRIPTORS; index += 1) {
    const entry = table + index * layout.size;
    if (entry + layout.size > bytes.length) break;
    if (bytes.subarray(entry, entry + layout.size).every((byte) => byte === 0)) break;
    const nameOffset = rvaToOffset(sections, view.getUint32(entry + layout.nameField, true));
    if (nameOffset !== null) names.push(readCString(bytes, nameOffset));
  }
  return names;
}

function readCString(bytes: Uint8Array, offset: number): string {
  const end = bytes.indexOf(0, offset);
  return new TextDecoder('latin1').decode(bytes.subarray(offset, end === -1 ? undefined : end));
}

/** `CheckSum` sits 64 bytes into the PE32 and PE32+ optional headers alike. */
const PE_CHECKSUM_FIELD = 64;
const LC_CODE_SIGNATURE = 0x1d;
const CODE_SIGNATURE_SUPERBLOB_MAGIC = 0xfade_0cc0;
const CODE_SIGNATURE_DIRECTORY_MAGIC = 0xfade_0c02;
const MACHO_HEADER_BYTES = 32;

/**
 * The optional header's `CheckSum` of a PE32+ executable. MSVC's linker writes 0 unless `/RELEASE`
 * or a driver subsystem asks for a real one, and patching a binary invalidates a real one.
 * Throws, naming what was found, for anything that is not a PE32+ file.
 *
 * @example
 * readPeCheckSum(new Uint8Array(await Bun.file('mangostudio-runtime.exe').arrayBuffer())); // → 0
 */
export function readPeCheckSum(bytes: Uint8Array): number {
  const header = readExecutableHeader(bytes);
  if (header.format !== 'pe') {
    throw new Error(`expected a PE executable to read CheckSum from | received: ${header.format}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const field = view.getUint32(0x3c, true) + 24 + PE_CHECKSUM_FIELD;
  if (field + 4 > bytes.length) {
    throw new Error(
      `expected a PE optional header holding CheckSum | received: ${bytes.length} bytes, field at ${field}`
    );
  }
  return view.getUint32(field, true);
}

/**
 * The ad hoc code signature a 64-bit Mach-O carries: the identifier its `CodeDirectory` names, or
 * `null` when the file has no `LC_CODE_SIGNATURE`. Apple's linker signs arm64 output itself, and
 * a signed binary that is edited afterwards no longer verifies, so a patcher uses this to know
 * whether it owes a re-sign and under which identifier.
 *
 * @example
 * readMachOSignature(bytes); // → { identifier: 'mangostudio_runtime-3f9a1c0d2b7e4a55' }
 */
export function readMachOSignature(bytes: Uint8Array): { readonly identifier: string } | null {
  const header = readExecutableHeader(bytes);
  if (header.format !== 'macho') {
    throw new Error(
      `expected a Mach-O executable to read a signature from | received: ${header.format}`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commandCount = view.getUint32(16, true);
  let command = MACHO_HEADER_BYTES;
  for (let index = 0; index < commandCount; index += 1) {
    if (command + 8 > bytes.length) break;
    const kind = view.getUint32(command, true);
    const size = view.getUint32(command + 4, true);
    if (size < 8) break;
    if (kind === LC_CODE_SIGNATURE) {
      return { identifier: readCodeDirectoryIdentifier(bytes, view, command) };
    }
    command += size;
  }
  return null;
}

function readCodeDirectoryIdentifier(bytes: Uint8Array, view: DataView, command: number): string {
  if (command + 16 > bytes.length) {
    throw new Error(`expected a whole LC_CODE_SIGNATURE command | received offset ${command}`);
  }
  const dataOffset = view.getUint32(command + 8, true);
  const dataSize = view.getUint32(command + 12, true);
  if (dataSize < 12 || dataOffset + dataSize > bytes.length) {
    throw new Error(
      `expected a code signature inside the file | received: offset ${dataOffset}, size ${dataSize}, file ${bytes.length} bytes`
    );
  }
  // Code signature structures are big-endian regardless of the file's byte order.
  if (view.getUint32(dataOffset, false) !== CODE_SIGNATURE_SUPERBLOB_MAGIC) {
    throw new Error(
      `expected a code signature SuperBlob (magic 0xfade0cc0) | received: 0x${view.getUint32(dataOffset, false).toString(16)}`
    );
  }
  const blobCount = view.getUint32(dataOffset + 8, false);
  for (let blob = 0; blob < blobCount; blob += 1) {
    const entry = dataOffset + 12 + blob * 8;
    if (entry + 8 > dataOffset + dataSize) break;
    const directory = dataOffset + view.getUint32(entry + 4, false);
    if (
      directory + 24 <= bytes.length &&
      view.getUint32(directory, false) === CODE_SIGNATURE_DIRECTORY_MAGIC
    ) {
      const identifier = readCString(bytes, directory + view.getUint32(directory + 20, false));
      if (identifier.length === 0) {
        throw new Error('expected a non-empty code signature identifier | received: empty');
      }
      return identifier;
    }
  }
  throw new Error(
    `expected a CodeDirectory (magic 0xfade0c02) in the code signature | received ${blobCount} blob(s) without one`
  );
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
