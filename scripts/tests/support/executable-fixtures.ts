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
 * A PE32+ (or, with `pe32`, a 32-bit PE32) header for one CPU.
 *
 * @example
 * fakePe('x64');
 */
export function fakePe(arch: Arch, options: { pe32?: boolean } = {}): Uint8Array {
  const bytes = new Uint8Array(0x40 + 24 + 8);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a], 0);
  view.setUint32(0x3c, 0x40, true);
  view.setUint32(0x40, 0x5045_0000, false);
  view.setUint16(0x44, PE_MACHINE[arch], true);
  view.setUint16(0x40 + 24, options.pe32 ? 0x10b : 0x20b, true);
  return bytes;
}
