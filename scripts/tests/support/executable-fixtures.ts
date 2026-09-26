// Minimal executable headers for the header-parsing tests: just the bytes
// `readExecutableHeader` reads, laid out the way each format places them.

const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 } as const;
const MACHO_CPU = { x64: 0x0100_0007, arm64: 0x0100_000c } as const;
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 } as const;

type Arch = keyof typeof ELF_MACHINE;

/**
 * A 64-bit little-endian ELF with one program header: `PT_INTERP` naming
 * `interpreter`, or a `PT_LOAD` when it is `null` (a static executable).
 * `strings` land after the headers, where `.dynstr` would carry `GLIBC_x.y`.
 *
 * @example
 * fakeElf({ arch: 'x64', interpreter: '/lib64/ld-linux-x86-64.so.2', strings: ['GLIBC_2.17'] });
 */
export function fakeElf(options: {
  arch: Arch;
  interpreter: string | null;
  strings?: readonly string[];
}): Uint8Array {
  const interp = new TextEncoder().encode(`${options.interpreter ?? ''}\0`);
  const tail = new TextEncoder().encode((options.strings ?? []).join('\0'));
  const phoff = 64;
  const interpOffset = phoff + 56;
  const bytes = new Uint8Array(interpOffset + interp.length + tail.length + 8);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(18, ELF_MACHINE[options.arch], true);
  view.setBigUint64(32, BigInt(phoff), true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint32(phoff, options.interpreter === null ? 1 : 3, true);
  view.setBigUint64(phoff + 8, BigInt(interpOffset), true);
  view.setBigUint64(phoff + 32, BigInt(interp.length), true);
  bytes.set(interp, interpOffset);
  bytes.set(tail, interpOffset + interp.length);
  return bytes;
}

/**
 * A thin 64-bit Mach-O header for one CPU.
 *
 * @example
 * fakeMachO('arm64');
 */
export function fakeMachO(arch: Arch): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeed_facf, true);
  view.setUint32(4, MACHO_CPU[arch], true);
  return bytes;
}

/**
 * A PE32+ (or, with `pe32`, a 32-bit PE32) header for one CPU. `imports` and
 * `delayImports` become one `.idata`-style section holding the import and
 * delay-import descriptor tables and their DLL names, laid out as a linker
 * would: descriptors at RVAs the data directories point to, names by RVA.
 *
 * @example
 * fakePe('x64', { imports: ['KERNEL32.dll', 'VCRUNTIME140.dll'] });
 */
export function fakePe(
  arch: Arch,
  options: { pe32?: boolean; imports?: readonly string[]; delayImports?: readonly string[] } = {}
): Uint8Array {
  const imports = options.imports ?? [];
  const delayImports = options.delayImports ?? [];
  const peOffset = 0x40;
  const optionalOffset = peOffset + 24;
  const optionalSize = 112 + 16 * 8;
  const sectionTable = optionalOffset + optionalSize;
  const rawOffset = 0x200;
  const sectionRva = 0x1000;

  const importTable = 0;
  const delayTable = (imports.length + 1) * 20;
  let nameCursor = delayTable + (delayImports.length + 1) * 32;
  const encoder = new TextEncoder();
  const names = [...imports, ...delayImports].map((name) => {
    const at = nameCursor;
    nameCursor += name.length + 1;
    return { at, bytes: encoder.encode(name) };
  });
  const rawSize = nameCursor;

  const bytes = new Uint8Array(rawOffset + rawSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a], 0);
  view.setUint32(0x3c, peOffset, true);
  view.setUint32(peOffset, 0x5045_0000, false);
  view.setUint16(peOffset + 4, PE_MACHINE[arch], true);
  view.setUint16(peOffset + 6, 1, true);
  view.setUint16(peOffset + 20, optionalSize, true);
  view.setUint16(optionalOffset, options.pe32 ? 0x10b : 0x20b, true);
  view.setUint32(optionalOffset + 108, 16, true);
  if (imports.length > 0)
    view.setUint32(optionalOffset + 112 + 1 * 8, sectionRva + importTable, true);
  if (delayImports.length > 0) {
    view.setUint32(optionalOffset + 112 + 13 * 8, sectionRva + delayTable, true);
  }

  view.setUint32(sectionTable + 8, rawSize, true);
  view.setUint32(sectionTable + 12, sectionRva, true);
  view.setUint32(sectionTable + 16, rawSize, true);
  view.setUint32(sectionTable + 20, rawOffset, true);

  names.forEach((name, index) => {
    const descriptor =
      index < imports.length
        ? importTable + index * 20 + 12
        : delayTable + (index - imports.length) * 32 + 4;
    view.setUint32(rawOffset + descriptor, sectionRva + name.at, true);
    bytes.set(name.bytes, rawOffset + name.at);
  });
  return bytes;
}
