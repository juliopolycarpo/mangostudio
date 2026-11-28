import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMachOSignature, readPeCheckSum } from '../lib/executable-header';
import {
  codesignArguments,
  type CodesignResult,
  type CodesignRunner,
  findReleaseStampSlots,
  readReleaseStamp,
  RELEASE_STAMP_MAGIC,
  RELEASE_STAMP_SLOT_BYTES,
  RELEASE_STAMP_VALUE_CAPACITY,
  stampReleaseVersion,
  stampRuntimeFile,
} from '../lib/runtime-stamp';
import { fakeElf, fakePe, fakeSignedMachO, withTail } from './support/executable-fixtures';

/** The slot `src/main.rs` links in: the magic, then zeros (unstamped). */
function unstampedSlot(): Uint8Array {
  const slot = new Uint8Array(RELEASE_STAMP_SLOT_BYTES);
  slot.set(RELEASE_STAMP_MAGIC, 0);
  return slot;
}

/** A slot already stamped with `version`, laid out the way the patcher writes it. */
function stampedSlot(version: string): Uint8Array {
  const slot = unstampedSlot();
  slot[RELEASE_STAMP_MAGIC.length] = version.length;
  slot.set(new TextEncoder().encode(version), RELEASE_STAMP_MAGIC.length + 1);
  return slot;
}

/** An x64 ELF with `slots` after its headers, separated by filler. */
function elfWith(...slots: Uint8Array[]): Uint8Array {
  let bytes = fakeElf({ arch: 'x64', interpreter: null });
  for (const slot of slots) bytes = withTail(withTail(bytes, new Uint8Array(16)), slot);
  return bytes;
}

/**
 * Names of every byte offset at which `left` and `right` differ.
 *
 * Usage: `differingOffsets(a, b)` is `[3, 4]` for two buffers that differ in bytes 3 and 4.
 */
function differingOffsets(left: Uint8Array, right: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) offsets.push(index);
  }
  return offsets;
}

/** Named fake of the `codesign` invocation: records every call and answers with `result`. */
class FakeCodesign {
  readonly calls: (readonly string[])[] = [];

  constructor(private readonly result: CodesignResult = { exitCode: 0, output: '' }) {}

  readonly run: CodesignRunner = (args) => {
    this.calls.push(args);
    return this.result;
  };
}

describe('stampReleaseVersion on an ELF', () => {
  test('writes the version and zeroes the rest of the slot', () => {
    const bytes = elfWith(unstampedSlot());
    const before = Uint8Array.from(bytes);

    const outcome = stampReleaseVersion(bytes, '0.1.1-canary.1234abc');

    expect(outcome).toMatchObject({ format: 'elf', changed: true, signatureIdentifier: null });
    expect(readReleaseStamp(bytes)).toEqual({
      offset: outcome.offset,
      version: '0.1.1-canary.1234abc',
    });
    // Only the length byte and the value change; the magic and everything outside the slot stay.
    const changed = differingOffsets(before, bytes);
    expect(changed[0]).toBe(outcome.offset + RELEASE_STAMP_MAGIC.length);
    expect(changed.at(-1)).toBeLessThan(outcome.offset + RELEASE_STAMP_SLOT_BYTES);
  });

  test('two versions leave binaries that differ only inside the slot', () => {
    const first = elfWith(unstampedSlot());
    const second = Uint8Array.from(first);
    const { offset } = stampReleaseVersion(first, '0.1.1-canary.1111111');
    stampReleaseVersion(second, '0.1.1-canary.2222222');

    const changed = differingOffsets(first, second);

    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((at) => at > offset && at < offset + RELEASE_STAMP_SLOT_BYTES)).toBe(true);
  });

  test('is idempotent for the same version and writes nothing the second time', () => {
    const bytes = elfWith(unstampedSlot());
    stampReleaseVersion(bytes, '0.1.1');
    const once = Uint8Array.from(bytes);

    const outcome = stampReleaseVersion(bytes, '0.1.1');

    expect(outcome.changed).toBe(false);
    expect(differingOffsets(once, bytes)).toEqual([]);
  });

  test('refuses a slot stamped with another version, naming both', () => {
    const bytes = elfWith(stampedSlot('0.1.1'));

    expect(() => stampReleaseVersion(bytes, '0.2.0')).toThrow(
      'expected an unstamped release slot or one already carrying 0.2.0 | received: 0.1.1'
    );
  });

  test('refuses a binary without the magic, naming the count', () => {
    expect(() => stampReleaseVersion(elfWith(), '0.1.1')).toThrow(
      'expected exactly 1 release stamp slot (16-byte magic) in the binary | received: 0'
    );
  });

  test('refuses a binary holding the magic twice, naming the count and offsets', () => {
    const bytes = elfWith(unstampedSlot(), unstampedSlot());
    const offsets = findReleaseStampSlots(bytes);

    expect(offsets).toHaveLength(2);
    expect(() => stampReleaseVersion(bytes, '0.1.1')).toThrow(
      `received: 2 at offsets ${offsets.join(', ')}`
    );
  });

  test('refuses a version longer than the field, naming its length', () => {
    const tooLong = `1.0.0-${'a'.repeat(RELEASE_STAMP_VALUE_CAPACITY)}`;

    expect(() => stampReleaseVersion(elfWith(unstampedSlot()), tooLong)).toThrow(
      `expected a release version of at most 64 bytes | received: ${tooLong.length} bytes`
    );
  });

  test('accepts a version that fills the field exactly', () => {
    const exact = `1.0.0-${'a'.repeat(RELEASE_STAMP_VALUE_CAPACITY - 6)}`;
    const bytes = elfWith(unstampedSlot());

    stampReleaseVersion(bytes, exact);

    expect(readReleaseStamp(bytes).version).toBe(exact);
  });

  test.each(['', ' 1.0.0', '1.0.0\n', '1.0.é'])('refuses the unstampable version %j', (version) => {
    expect(() => stampReleaseVersion(elfWith(unstampedSlot()), version)).toThrow(
      'expected a release version of printable ASCII without spaces'
    );
  });

  test('refuses a slot whose padding is dirty, naming the byte', () => {
    const slot = stampedSlot('1.2.3');
    slot[RELEASE_STAMP_MAGIC.length + 1 + 9] = 0x7a;

    expect(() => readReleaseStamp(elfWith(slot))).toThrow(
      'expected zero padding after the 5-byte release stamp | received: byte 0x7a at value index 9'
    );
  });

  test('refuses a length byte above the capacity', () => {
    const slot = unstampedSlot();
    slot[RELEASE_STAMP_MAGIC.length] = 65;

    expect(() => readReleaseStamp(elfWith(slot))).toThrow(
      'expected release stamp length 0..=64 | received: 65'
    );
  });

  test('refuses a slot cut off by the end of the file', () => {
    const bytes = withTail(
      fakeElf({ arch: 'x64', interpreter: null }),
      unstampedSlot().subarray(0, 40)
    );

    expect(() => stampReleaseVersion(bytes, '0.1.1')).toThrow(
      'expected a release stamp slot of 81 bytes inside the file'
    );
  });
});

describe('stampReleaseVersion on a PE', () => {
  test('stamps while the optional-header CheckSum is 0', () => {
    const bytes = withTail(fakePe('x64'), unstampedSlot());

    const outcome = stampReleaseVersion(bytes, '0.1.1');

    expect(outcome).toMatchObject({ format: 'pe', changed: true });
    expect(readPeCheckSum(bytes)).toBe(0);
    expect(readReleaseStamp(bytes).version).toBe('0.1.1');
  });

  test('refuses a non-zero CheckSum, which the patch would invalidate', () => {
    const bytes = withTail(fakePe('arm64', { checkSum: 0x00ab_cdef }), unstampedSlot());

    expect(() => stampReleaseVersion(bytes, '0.1.1')).toThrow(
      'expected a PE optional-header CheckSum of 0 (patching would invalidate it) | received: 0xabcdef'
    );
    expect(readReleaseStamp(bytes).version).toBeNull();
  });

  test('reads CheckSum from the optional header', () => {
    expect(readPeCheckSum(fakePe('x64', { checkSum: 7 }))).toBe(7);
    expect(() => readPeCheckSum(fakeElf({ arch: 'x64', interpreter: null }))).toThrow(
      'expected a PE executable to read CheckSum from | received: elf'
    );
  });
});

describe('stampReleaseVersion on a Mach-O', () => {
  test('reports the identifier the linker signed under', () => {
    const bytes = fakeSignedMachO('arm64', 'mangostudio_runtime-3f9a1c0d2b7e4a55');

    expect(readMachOSignature(bytes)).toEqual({
      identifier: 'mangostudio_runtime-3f9a1c0d2b7e4a55',
    });
    expect(readMachOSignature(fakeSignedMachO('x64', 'x', { unsigned: true }))).toBeNull();
  });

  test('a signed binary carries the identifier forward for the re-sign', () => {
    const bytes = withTail(fakeSignedMachO('arm64', 'mangostudio-runtime'), unstampedSlot());

    expect(stampReleaseVersion(bytes, '0.1.1')).toMatchObject({
      format: 'macho',
      changed: true,
      signatureIdentifier: 'mangostudio-runtime',
    });
  });

  test('an unsigned x64 binary is patched without a signature to restore', () => {
    const bytes = withTail(fakeSignedMachO('x64', 'unused', { unsigned: true }), unstampedSlot());

    expect(stampReleaseVersion(bytes, '0.1.1')).toMatchObject({
      changed: true,
      signatureIdentifier: null,
    });
  });

  test('refuses an unsigned arm64 binary, which could not run once patched', () => {
    const bytes = withTail(fakeSignedMachO('arm64', 'unused', { unsigned: true }), unstampedSlot());

    expect(() => stampReleaseVersion(bytes, '0.1.1')).toThrow(
      'expected a signed arm64 Mach-O (the linker signs arm64 output) | received: no LC_CODE_SIGNATURE'
    );
  });
});

describe('stampRuntimeFile', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'runtime-stamp-unit-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(name: string, bytes: Uint8Array): string {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return path;
  }

  test('stamps an ELF in place without re-signing anything', () => {
    const path = write('runtime', elfWith(unstampedSlot()));
    const codesign = new FakeCodesign();

    const outcome = stampRuntimeFile(path, '0.1.1-canary.1234abc', { codesign: codesign.run });

    expect(outcome.changed).toBe(true);
    expect(readReleaseStamp(readFileSync(path)).version).toBe('0.1.1-canary.1234abc');
    expect(codesign.calls).toEqual([]);
  });

  test('re-signs a signed Mach-O ad hoc under its own identifier after stamping', () => {
    const path = write(
      'runtime',
      withTail(fakeSignedMachO('arm64', 'mangostudio_runtime-3f9a'), unstampedSlot())
    );
    const codesign = new FakeCodesign();

    stampRuntimeFile(path, '0.1.1', { codesign: codesign.run });

    expect(codesign.calls).toEqual([
      ['--force', '--sign', '-', '--identifier', 'mangostudio_runtime-3f9a', path],
    ]);
    expect(codesign.calls[0]).toEqual(codesignArguments(path, 'mangostudio_runtime-3f9a'));
  });

  test('a failing codesign fails the stamp with the exit code and its output', () => {
    const path = write('runtime', withTail(fakeSignedMachO('arm64', 'id'), unstampedSlot()));
    const codesign = new FakeCodesign({ exitCode: 127, output: 'spawn codesign ENOENT' });

    expect(() => stampRuntimeFile(path, '0.1.1', { codesign: codesign.run })).toThrow(
      `expected codesign to re-sign ${path} as id after stamping (darwin runtimes build on macOS; discard the file, its signature no longer matches) | received: exit 127: spawn codesign ENOENT`
    );
  });

  test('an already stamped runtime is neither rewritten nor re-signed', () => {
    const path = write('runtime', withTail(fakeSignedMachO('arm64', 'id'), stampedSlot('0.1.1')));
    const before = readFileSync(path);
    const codesign = new FakeCodesign();

    const outcome = stampRuntimeFile(path, '0.1.1', { codesign: codesign.run });

    expect(outcome.changed).toBe(false);
    expect(codesign.calls).toEqual([]);
    expect(differingOffsets(before, readFileSync(path))).toEqual([]);
  });

  test('a refused stamp leaves the file untouched', () => {
    const path = write('runtime', elfWith(unstampedSlot(), unstampedSlot()));
    const before = readFileSync(path);

    expect(() => stampRuntimeFile(path, '0.1.1')).toThrow('received: 2 at offsets');
    expect(differingOffsets(before, readFileSync(path))).toEqual([]);
  });
});
