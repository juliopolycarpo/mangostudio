import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFileFreshness, PathAccessError } from '../../../src';
import { runtimeFsService } from '../../../src/services/fs';
import {
  captureFileSnapshot,
  RUNTIME_SNAPSHOT_MAX_BYTES,
  RuntimeSnapshotTooLargeError,
  revertRuntimeSnapshots,
} from '../../../src/services/snapshot';

let tempDir: string;
let outsideDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-snapshot-test-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'runtime-snapshot-out-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

async function writeOversizedFile(path: string): Promise<void> {
  await Bun.write(path, new Uint8Array(RUNTIME_SNAPSHOT_MAX_BYTES + 1));
}

describe('runtime snapshot capture', () => {
  it('rejects a file past the snapshot limit instead of encoding it', async () => {
    const path = join(tempDir, 'huge.bin');
    await writeOversizedFile(path);

    await expect(captureFileSnapshot(path)).rejects.toThrow(RuntimeSnapshotTooLargeError);
  });

  it('leaves the filesystem untouched when a move cannot be checkpointed', async () => {
    const from = join(tempDir, 'huge.bin');
    const to = join(tempDir, 'moved.bin');
    await writeOversizedFile(from);

    await expect(
      runtimeFsService.moveFile({
        chatId: 'chat-1',
        inputFrom: 'huge.bin',
        inputTo: 'moved.bin',
        resolvedFrom: from,
        resolvedTo: to,
        captureSnapshot: true,
      })
    ).rejects.toThrow(RuntimeSnapshotTooLargeError);

    expect(await Bun.file(from).exists()).toBe(true);
    expect(await Bun.file(to).exists()).toBe(false);
  });
});

describe('runtime snapshot revert containment', () => {
  it('rejects ../ escape paths when containmentRoot is set', async () => {
    const inside = join(tempDir, 'kept.txt');
    writeFileSync(inside, 'inside');
    const escaped = join(tempDir, '..', 'escape.txt');

    await expect(
      revertRuntimeSnapshots({
        chatId: 'chat-1',
        containmentRoot: tempDir,
        expected: [{ path: escaped, afterHash: 'deadbeef' }],
        operations: [{ type: 'create', path: escaped }],
      })
    ).rejects.toBeInstanceOf(PathAccessError);
  });

  it('rejects symlink escapes that leave the containment root', async () => {
    mkdirSync(join(tempDir, 'nested'));
    const linkPath = join(tempDir, 'escape-link');
    symlinkSync(outsideDir, linkPath);
    const escaped = join(linkPath, 'planted.txt');

    await expect(
      revertRuntimeSnapshots({
        chatId: 'chat-1',
        containmentRoot: tempDir,
        expected: [{ path: escaped, afterHash: 'deadbeef' }],
        operations: [{ type: 'create', path: escaped }],
      })
    ).rejects.toBeInstanceOf(PathAccessError);
  });
});
