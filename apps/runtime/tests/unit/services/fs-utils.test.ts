/**
 * The bounded reader behind every runtime file read, re-homed from the hub's
 * `_fs-utils` test when the hub stopped importing it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileWithObservedMtime } from '../../../src/services/fs-utils';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fs-utils-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('readFileWithObservedMtime', () => {
  it('reads file bytes when under the maxBytes ceiling', async () => {
    const filePath = join(tempDir, 'small.txt');
    await Bun.write(filePath, 'hello');

    const { bytes } = await readFileWithObservedMtime(filePath, { maxBytes: 10 });
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('rejects files larger than maxBytes before allocating content', async () => {
    const filePath = join(tempDir, 'too-big.txt');
    await Bun.write(filePath, '0123456789');

    await expect(readFileWithObservedMtime(filePath, { maxBytes: 5 })).rejects.toThrow(
      /too large \(10 bytes; limit is 5\)/
    );
  });

  it('defaults to an unbounded ceiling so freshness hashing stays unrestricted', async () => {
    const filePath = join(tempDir, 'unbounded.txt');
    await Bun.write(filePath, 'ok');

    const { bytes } = await readFileWithObservedMtime(filePath);
    expect(bytes.byteLength).toBe(2);
  });

  it('reads a file sized exactly at the ceiling', async () => {
    const filePath = join(tempDir, 'exact.bin');
    await Bun.write(filePath, new Uint8Array(64));

    const { bytes } = await readFileWithObservedMtime(filePath, { maxBytes: 64 });
    expect(bytes.byteLength).toBe(64);
  });

  it('reads a file larger than its own stat size, up to the ceiling', async () => {
    // The growth loop is what keeps a stat-vs-read mismatch from truncating an
    // ordinary read; the ceiling is the only thing that stops it.
    const filePath = join(tempDir, 'grown.txt');
    await Bun.write(filePath, '0123456789');

    const { bytes } = await readFileWithObservedMtime(filePath, { maxBytes: 1_000 });
    expect(new TextDecoder().decode(bytes)).toBe('0123456789');
  });

  // A procfs entry is the reproduction case from the issue: `stat` reports
  // `size: 0`, so the pre-read check passes trivially, and the descriptor then
  // streams however many bytes it likes. The ceiling has to bind the read.
  it.skipIf(process.platform !== 'linux')(
    'bounds a file whose stat under-reports its size by the bytes actually read',
    async () => {
      await expect(
        readFileWithObservedMtime('/proc/self/status', { maxBytes: 64 })
      ).rejects.toThrow(/too large \(at least 65 bytes; limit is 64\)/);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'still reads a stat-less file in full when it fits under the ceiling',
    async () => {
      const { bytes } = await readFileWithObservedMtime('/proc/self/status', {
        maxBytes: 1024 * 1024,
      });

      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(new TextDecoder().decode(bytes)).toContain('Name:');
    }
  );
});
