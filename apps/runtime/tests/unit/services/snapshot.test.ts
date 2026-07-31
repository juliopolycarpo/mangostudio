import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFileFreshness } from '../../../src';
import { runtimeFsService } from '../../../src/services/fs';
import {
  captureFileSnapshot,
  RUNTIME_SNAPSHOT_MAX_BYTES,
  RuntimeSnapshotTooLargeError,
} from '../../../src/services/snapshot';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-snapshot-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
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
