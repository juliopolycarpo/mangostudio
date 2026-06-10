import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChecksum, sha256File } from '../release/verify-checksum';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-checksum-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

describe('sha256File', () => {
  test('hashes file contents with SHA-256', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'asset.tar.gz');
    writeFileSync(filePath, 'release asset');

    expect(sha256File(filePath)).toBe(
      'e6abe9df7db8513616674b02b5edb26c37bf3b2f81daeec1e3c6fc8c9a802850'
    );
  });
});

describe('findChecksum', () => {
  test('reads sha256sum output for the requested asset', () => {
    const checksum = 'a'.repeat(64);
    const manifest = `${'b'.repeat(64)}  other.tar.gz\n${checksum}  asset.tar.gz\n`;

    expect(findChecksum(manifest, 'asset.tar.gz')).toBe(checksum);
  });

  test('throws when the asset is missing from the manifest', () => {
    expect(() => findChecksum(`${'a'.repeat(64)}  other.tar.gz`, 'asset.tar.gz')).toThrow(
      /does not contain asset\.tar\.gz/
    );
  });
});
