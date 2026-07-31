import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFileFreshness } from '../../../src';
import { runtimeFsService } from '../../../src/services/fs';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-fs-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runtime filesystem service', () => {
  it('owns the read-modify-write freshness lifecycle and returns snapshots', async () => {
    const path = join(tempDir, 'nested', 'file.txt');
    const created = await runtimeFsService.createFile({
      chatId: 'chat-1',
      inputPath: 'nested/file.txt',
      resolvedPath: path,
      content: 'before\n',
      captureSnapshot: true,
    });

    expect(created.result).toMatchObject({
      path: 'nested/file.txt',
      bytesWritten: 7,
    });
    expect(created.mutations).toEqual([
      {
        path,
        op: 'create',
        before: { exists: false },
        afterHash: created.result.sha256,
      },
    ]);

    const read = await runtimeFsService.readFile({
      chatId: 'chat-1',
      inputPath: 'nested/file.txt',
      resolvedPath: path,
    });
    expect(read.content).toContain('before');

    const edited = await runtimeFsService.editFile({
      chatId: 'chat-1',
      inputPath: 'nested/file.txt',
      resolvedPath: path,
      oldString: 'before',
      newString: 'after',
      captureSnapshot: true,
    });
    expect(edited.result.replacements).toBe(1);
    expect(edited.mutations[0]).toMatchObject({
      path,
      op: 'edit',
      before: {
        exists: true,
        contentBase64: Buffer.from('before\n').toString('base64'),
      },
      afterHash: edited.result.sha256,
    });
    expect(await Bun.file(path).text()).toBe('after\n');
  });

  it('filters glob results by denied roots and real-path containment', async () => {
    const root = join(tempDir, 'workspace');
    const denied = join(root, 'private');
    const outside = join(tempDir, 'outside');
    mkdirSync(denied, { recursive: true });
    mkdirSync(outside, { recursive: true });
    await Bun.write(join(root, 'visible.txt'), 'visible');
    await Bun.write(join(denied, 'secret.txt'), 'secret');
    await Bun.write(join(outside, 'escaped.txt'), 'escaped');
    symlinkSync(outside, join(root, 'escape'));

    const result = await runtimeFsService.glob({
      pattern: '**/*.txt',
      cwd: root,
      maxResults: 100,
      includeDotfiles: false,
      absolute: true,
      allowedRoots: [root],
      deniedRoots: [denied],
      containmentRoot: root,
    });

    expect(result.matches).toEqual([join(root, 'visible.txt')]);
  });
});
