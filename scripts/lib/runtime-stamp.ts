// Writes the release version into a linked `mangostudio-runtime`.
//
// The release version is not a compile input: `crates/mangostudio-runtime/src/main.rs` carries a
// fixed-size slot, and this module fills it after the link, so two commits with equal Rust inputs
// compile to the same bytes and differ only in the slot once stamped. The slot is
//
//   | magic: 16 bytes | length: 1 byte (0 = unstamped) | value: 64 bytes, zero-padded |
//
// and `crates/mangostudio-runtime/src/release_stamp.rs` reads it. Dependency-free (Node built-ins
// only): the runtime build legs run it with `bun --no-install`.
//
// Per format: ELF is patched in place. PE is patched only while its optional-header `CheckSum` is
// 0 (MSVC's default), because a real checksum would no longer match. A Mach-O is patched and then
// re-signed ad hoc under the identifier the linker chose, because arm64 refuses to run a binary
// whose code-signature page hashes no longer match.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  type ExecutableFormat,
  readExecutableHeader,
  readMachOSignature,
  readPeCheckSum,
} from './executable-header';

/**
 * The marker the patcher searches for. Pinned to `STAMP_MAGIC` in `crates/mangostudio-runtime/src/main.rs`
 * by `scripts/tests/runtime-stamp.unit.test.ts`; random bytes, so nothing else in a binary collides.
 */
export const RELEASE_STAMP_MAGIC: Uint8Array = Uint8Array.from([
  0x1a, 0x42, 0x4a, 0x48, 0x2a, 0x3c, 0x9b, 0xff, 0xa0, 0x2d, 0xe3, 0xfe, 0x39, 0x92, 0x88, 0x81,
]);

/** Longest release version the slot holds, in bytes: `VALUE_CAPACITY` in `release_stamp.rs`. */
export const RELEASE_STAMP_VALUE_CAPACITY = 64;

/** Offset of the length byte from the start of the magic. */
const LENGTH_OFFSET = RELEASE_STAMP_MAGIC.length;
const VALUE_OFFSET = LENGTH_OFFSET + 1;

/** Size of the whole slot: `SLOT_LEN` in `release_stamp.rs`. */
export const RELEASE_STAMP_SLOT_BYTES = VALUE_OFFSET + RELEASE_STAMP_VALUE_CAPACITY;

/** Printable ASCII without spaces: every semver the release pipeline produces. */
const STAMPABLE_VERSION = /^[\x21-\x7e]+$/;

export interface ReleaseStampReading {
  /** Offset of the slot's magic in the file. */
  readonly offset: number;
  /** The stamped version, or `null` while the slot is unstamped. */
  readonly version: string | null;
}

export interface StampOutcome {
  /** Offset of the slot's magic in the file. */
  readonly offset: number;
  readonly format: ExecutableFormat;
  /** False when the slot already carried this version, so nothing was written. */
  readonly changed: boolean;
  /** Mach-O only: the identifier its existing signature names, or `null` when unsigned. */
  readonly signatureIdentifier: string | null;
}

/**
 * Every offset at which the slot magic occurs, overlapping occurrences included.
 *
 * @example
 * findReleaseStampSlots(bytes); // → [4_194_304]
 */
export function findReleaseStampSlots(bytes: Uint8Array): number[] {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const needle = Buffer.from(RELEASE_STAMP_MAGIC);
  const offsets: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    offsets.push(at);
  }
  return offsets;
}

function singleSlot(bytes: Uint8Array): number {
  const offsets = findReleaseStampSlots(bytes);
  if (offsets.length !== 1) {
    throw new Error(
      `expected exactly 1 release stamp slot (${RELEASE_STAMP_MAGIC.length}-byte magic) in the binary | received: ${offsets.length}${
        offsets.length > 0 ? ` at offsets ${offsets.join(', ')}` : ''
      }`
    );
  }
  const offset = offsets[0];
  if (offset + RELEASE_STAMP_SLOT_BYTES > bytes.length) {
    throw new Error(
      `expected a release stamp slot of ${RELEASE_STAMP_SLOT_BYTES} bytes inside the file | received: magic at ${offset} of ${bytes.length} bytes`
    );
  }
  return offset;
}

/**
 * The slot's current contents. Throws, naming the count, unless the binary holds the magic exactly
 * once, and throws when the length byte or the zero padding is malformed.
 *
 * @example
 * readReleaseStamp(bytes); // → { offset: 4194304, version: '0.1.1-canary.1234abc' }
 */
export function readReleaseStamp(bytes: Uint8Array): ReleaseStampReading {
  const offset = singleSlot(bytes);
  const length = bytes[offset + LENGTH_OFFSET];
  if (length > RELEASE_STAMP_VALUE_CAPACITY) {
    throw new Error(
      `expected release stamp length 0..=${RELEASE_STAMP_VALUE_CAPACITY} | received: ${length} at offset ${offset + LENGTH_OFFSET}`
    );
  }
  const field = bytes.subarray(
    offset + VALUE_OFFSET,
    offset + VALUE_OFFSET + RELEASE_STAMP_VALUE_CAPACITY
  );
  const dirty = field.findIndex((byte, index) => index >= length && byte !== 0);
  if (dirty !== -1) {
    throw new Error(
      `expected zero padding after the ${length}-byte release stamp | received: byte 0x${field[dirty].toString(16)} at value index ${dirty}`
    );
  }
  return {
    offset,
    version: length === 0 ? null : Buffer.from(field.subarray(0, length)).toString('latin1'),
  };
}

function assertStampableVersion(version: string): void {
  if (!STAMPABLE_VERSION.test(version)) {
    throw new Error(
      `expected a release version of printable ASCII without spaces | received: ${JSON.stringify(version)}`
    );
  }
  if (version.length > RELEASE_STAMP_VALUE_CAPACITY) {
    throw new Error(
      `expected a release version of at most ${RELEASE_STAMP_VALUE_CAPACITY} bytes | received: ${version.length} bytes (${version})`
    );
  }
}

/**
 * Write `version` into the slot of a linked runtime held in memory, mutating `bytes`. Idempotent:
 * a slot that already carries `version` is left alone. Throws when the version cannot be stamped,
 * when the magic is not present exactly once, when the slot carries a different version, or when
 * the format cannot be patched safely (a PE with a non-zero `CheckSum`).
 *
 * @example
 * stampReleaseVersion(bytes, '0.1.1-canary.1234abc'); // → { offset, format: 'elf', changed: true, signatureIdentifier: null }
 */
export function stampReleaseVersion(bytes: Uint8Array, version: string): StampOutcome {
  assertStampableVersion(version);
  const header = readExecutableHeader(bytes);
  const current = readReleaseStamp(bytes);
  const signature = header.format === 'macho' ? readMachOSignature(bytes) : null;
  const outcome = {
    offset: current.offset,
    format: header.format,
    signatureIdentifier: signature?.identifier ?? null,
  };
  if (current.version === version) return { ...outcome, changed: false };
  if (current.version !== null) {
    throw new Error(
      `expected an unstamped release slot or one already carrying ${version} | received: ${current.version}`
    );
  }
  if (header.format === 'pe') {
    const checksum = readPeCheckSum(bytes);
    if (checksum !== 0) {
      throw new Error(
        `expected a PE optional-header CheckSum of 0 (patching would invalidate it) | received: 0x${checksum.toString(16)}`
      );
    }
  }
  if (header.format === 'macho' && header.arch === 'arm64' && signature === null) {
    throw new Error(
      'expected a signed arm64 Mach-O (the linker signs arm64 output) | received: no LC_CODE_SIGNATURE'
    );
  }

  const value = Buffer.from(version, 'latin1');
  const slot = bytes.subarray(current.offset, current.offset + RELEASE_STAMP_SLOT_BYTES);
  slot[LENGTH_OFFSET] = value.length;
  slot.fill(0, VALUE_OFFSET);
  slot.set(value, VALUE_OFFSET);
  return { ...outcome, changed: true };
}

export interface CodesignResult {
  readonly exitCode: number;
  /** Combined stdout and stderr, for the failure message. */
  readonly output: string;
}

/** Runs `codesign` with these arguments. Injected so tests never need a macOS host. */
export type CodesignRunner = (args: readonly string[]) => CodesignResult;

/** Runs the host's `codesign`; exit code 127 stands for "not installed", as in a shell. */
const hostCodesign: CodesignRunner = (args) => {
  const result = spawnSync('codesign', [...args], { encoding: 'utf8' });
  if (result.error) return { exitCode: 127, output: result.error.message };
  return { exitCode: result.status ?? 1, output: `${result.stdout}${result.stderr}`.trim() };
};

/**
 * The `codesign` arguments that re-sign a patched Mach-O ad hoc under the identifier the linker
 * chose, so only the page hashes change.
 *
 * @example
 * codesignArguments('/out/mangostudio-runtime', 'mangostudio_runtime-3f9a');
 * // → ['--force', '--sign', '-', '--identifier', 'mangostudio_runtime-3f9a', '/out/mangostudio-runtime']
 */
export function codesignArguments(path: string, identifier: string): string[] {
  return ['--force', '--sign', '-', '--identifier', identifier, path];
}

/**
 * Stamp `version` into the runtime at `path`, then read the file back and confirm the slot holds
 * it. A Mach-O is re-signed with `options.codesign` (the host's by default); a host without
 * `codesign` fails the build rather than ship a binary arm64 would refuse to run.
 *
 * Stamp a staged copy, never cargo's own output: Cargo then keeps the unstamped binary for the
 * next build to reuse.
 *
 * @example
 * stampRuntimeFile('.mango/runtime/linux-x64/mangostudio-runtime', '0.1.1-canary.1234abc');
 */
export function stampRuntimeFile(
  path: string,
  version: string,
  options: { readonly codesign?: CodesignRunner } = {}
): StampOutcome {
  const bytes = readFileSync(path);
  const outcome = stampReleaseVersion(bytes, version);
  if (!outcome.changed) return outcome;
  writeFileSync(path, bytes);

  if (outcome.format === 'macho' && outcome.signatureIdentifier !== null) {
    const codesign = options.codesign ?? hostCodesign;
    const signed = codesign(codesignArguments(path, outcome.signatureIdentifier));
    if (signed.exitCode !== 0) {
      throw new Error(
        `expected codesign to re-sign ${path} as ${outcome.signatureIdentifier} after stamping (darwin runtimes build on macOS; discard the file, its signature no longer matches) | received: exit ${signed.exitCode}${signed.output ? `: ${signed.output}` : ''}`
      );
    }
  }

  const stamped = readReleaseStamp(readFileSync(path));
  if (stamped.version !== version) {
    throw new Error(
      `expected ${path} to carry release stamp ${version} after writing | received: ${stamped.version ?? 'unstamped'}`
    );
  }
  return outcome;
}

if (import.meta.main) {
  const [path, version, ...rest] = process.argv.slice(2);
  if (!path || !version || rest.length > 0) {
    console.error('Usage: bun scripts/lib/runtime-stamp.ts <runtime-binary> <version>');
    process.exit(2);
  }
  try {
    const outcome = stampRuntimeFile(path, version);
    console.log(
      `${path}: ${outcome.changed ? 'stamped' : 'already stamped'} ${version} (${outcome.format}, slot at offset ${outcome.offset})`
    );
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
