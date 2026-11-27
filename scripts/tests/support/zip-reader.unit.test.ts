import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { zipCreationCommand } from '../../lib/archive-creation';
import { FIXTURE_STOP_TIMEOUT_MS, FixtureCommands } from './fixture-command';
import { zipCreationUnavailable } from './host-tools';
import { readZipMembers } from './zip-reader';

// Skipped on a developer machine without `zip`; CI throws instead (see host-tools.ts).
const ZIP_UNAVAILABLE = zipCreationUnavailable();

interface HandBuiltMember {
  readonly name: string;
  readonly content: string;
  readonly method: 0 | 8 | 12;
  /** Overrides the stored CRC-32 to build a corrupt member. */
  readonly crc?: number;
}

const encoder = new TextEncoder();

/**
 * Lay out a ZIP byte by byte from the APPNOTE record layouts, independent of any writer under
 * test. Local headers carry an extra field and the end record an archive comment, because real
 * writers add both and the reader must not assume zero lengths.
 */
function handBuiltZip(
  members: readonly HandBuiltMember[],
  archiveComment = 'built by hand'
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    offset += bytes.length;
  };
  for (const member of members) {
    const name = encoder.encode(member.name);
    const raw = encoder.encode(member.content);
    // Method 12 (bzip2) is never decoded; its payload only has to exist.
    const payload = member.method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = member.crc ?? Bun.hash.crc32(raw);
    const localExtra = new Uint8Array([0xfe, 0xca, 0x02, 0x00, 0xaa, 0xbb]);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, member.method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, payload.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, localExtra.length, true);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, member.method, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, payload.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    push(new Uint8Array(local.buffer));
    push(name);
    push(localExtra);
    push(payload);
  }
  const directoryOffset = offset;
  for (const bytes of central) push(bytes);
  const comment = encoder.encode(archiveComment);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, members.length, true);
  end.setUint16(10, members.length, true);
  end.setUint32(12, offset - directoryOffset, true);
  end.setUint32(16, directoryOffset, true);
  end.setUint16(20, comment.length, true);
  push(new Uint8Array(end.buffer));
  push(comment);

  const archive = new Uint8Array(offset);
  let cursor = 0;
  for (const bytes of parts) {
    archive.set(bytes, cursor);
    cursor += bytes.length;
  }
  return archive;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('readZipMembers on a hand-built ZIP', () => {
  const compressible = 'mango '.repeat(500);

  test('reads stored and deflated members with names and bytes intact', () => {
    const members = readZipMembers(
      handBuiltZip([
        { name: "it's a name.txt", content: 'stored bytes', method: 0 },
        { name: 'nested/deflated.txt', content: compressible, method: 8 },
      ])
    );
    expect(members.map((member) => member.name)).toEqual([
      "it's a name.txt",
      'nested/deflated.txt',
    ]);
    const contentByName = new Map(members.map((member) => [member.name, text(member.bytes)]));
    expect(contentByName.get("it's a name.txt")).toBe('stored bytes');
    expect(contentByName.get('nested/deflated.txt')).toBe(compressible);
  });

  test('reads an archive with no members', () => {
    expect(readZipMembers(handBuiltZip([]))).toEqual([]);
  });

  test('rejects a member whose bytes do not match the recorded CRC-32', () => {
    expect(() =>
      readZipMembers(handBuiltZip([{ name: 'bad.txt', content: 'payload', method: 0, crc: 1 }]))
    ).toThrow(/\(zip member bad\.txt\): expected crc32 1 \| received \d+/);
  });

  test('rejects a compression method it cannot decode instead of returning raw bytes', () => {
    expect(() =>
      readZipMembers(handBuiltZip([{ name: 'bz.txt', content: 'payload', method: 12 }]))
    ).toThrow(
      '(zip member bz.txt): expected compression method 0 (stored) or 8 (deflate) | received 12'
    );
  });

  test('rejects bytes that are not a ZIP', () => {
    expect(() => readZipMembers(encoder.encode('not a zip, just text'))).toThrow(
      '(zip): expected an end-of-central-directory record | received none in 20 bytes'
    );
  });
});

describe('readZipMembers on a ZIP from zipCreationCommand', () => {
  const roots: string[] = [];
  const fixtureCommands = new FixtureCommands(undefined, 30_000);
  afterEach(async () => {
    await fixtureCommands.settle();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test.skipIf(ZIP_UNAVAILABLE)(
    'matches the staged files, including a deflated one',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'mango-zip-reader-'));
      roots.push(root);
      const staged = join(root, 'staged');
      mkdirSync(staged);
      const compressible = 'mango '.repeat(500);
      writeFileSync(join(staged, 'compressible.txt'), compressible);
      writeFileSync(join(staged, 'tiny.txt'), 'x');
      const archivePath = join(root, 'created.zip');
      const { command, cwd } = zipCreationCommand(archivePath, staged);
      const result = await fixtureCommands.run(command, cwd);
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);

      const members = readZipMembers(new Uint8Array(readFileSync(archivePath)));
      expect(members.map((member) => member.name).sort()).toEqual(['compressible.txt', 'tiny.txt']);
      const byName = new Map(members.map((member) => [member.name, text(member.bytes)]));
      expect(byName.get('compressible.txt')).toBe(compressible);
      expect(byName.get('tiny.txt')).toBe('x');
    },
    2 * (30_000 + FIXTURE_STOP_TIMEOUT_MS)
  );
});
