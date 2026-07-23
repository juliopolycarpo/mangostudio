import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeMoveFile,
  normalizeMoveFileToolSettings,
} from '../../../../src/services/tools/builtin/move-file';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import {
  assertFresh,
  clearFileFreshness,
  FileNotReadError,
} from '../../../../src/services/tools/file-freshness';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'move-file-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

describe('normalizeMoveFileToolSettings', () => {
  it('normalizes current and legacy path lists', () => {
    expect(normalizeMoveFileToolSettings({})).toEqual({
      allowedPaths: [],
      deniedPaths: [],
    });
    expect(
      normalizeMoveFileToolSettings({
        allowedPaths: '/home\n/tmp',
        deniedPaths: [{ path: '/etc', enabled: true }],
      })
    ).toEqual({
      allowedPaths: [
        { path: '/home', enabled: true },
        { path: '/tmp', enabled: true },
      ],
      deniedPaths: [{ path: '/etc', enabled: true }],
    });
  });
});

describe('executeMoveFile', () => {
  it('moves an unread file and creates destination parents', async () => {
    const from = join(tempDir, 'source.txt');
    const to = join(tempDir, 'nested', 'destination.txt');
    await Bun.write(from, 'move me');

    const result = await executeMoveFile({ from, to }, makeContext());

    expect(result).toEqual({ from, to, moved: true });
    expect(existsSync(from)).toBe(false);
    expect(await Bun.file(to).text()).toBe('move me');
  });

  it('anchors both relative paths to the chat workdir', async () => {
    const from = join(tempDir, 'source.txt');
    await Bun.write(from, 'move me');

    const result = await executeMoveFile(
      { from: 'source.txt', to: 'nested/destination.txt' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result).toEqual({
      from: 'source.txt',
      to: 'nested/destination.txt',
      moved: true,
    });
    expect(await Bun.file(join(tempDir, 'nested', 'destination.txt')).text()).toBe('move me');
  });

  it('never overwrites an existing destination', async () => {
    const from = join(tempDir, 'source.txt');
    const to = join(tempDir, 'destination.txt');
    await Bun.write(from, 'source');
    await Bun.write(to, 'destination');

    await expect(executeMoveFile({ from, to }, makeContext())).rejects.toThrow(
      `"${to}" already exists`
    );
    expect(await Bun.file(from).text()).toBe('source');
    expect(await Bun.file(to).text()).toBe('destination');
  });

  it('rekeys a source read so the destination stays fresh', async () => {
    const from = join(tempDir, 'source.txt');
    const to = join(tempDir, 'destination.txt');
    await Bun.write(from, 'observed');
    await executeReadFile({ path: from }, makeContext());

    await executeMoveFile({ from, to }, makeContext());

    await expect(assertFresh('c1', from)).rejects.toBeInstanceOf(FileNotReadError);
    await expect(assertFresh('c1', to)).resolves.toBeUndefined();
    const written = await executeWriteFile({ path: to, content: 'updated' }, makeContext());
    expect(written.created).toBe(false);
    expect(await Bun.file(to).text()).toBe('updated');
  });

  it('reports a missing source', async () => {
    const from = join(tempDir, 'missing.txt');
    const to = join(tempDir, 'destination.txt');

    await expect(executeMoveFile({ from, to }, makeContext())).rejects.toThrow(
      `File not found: "${from}"`
    );
    expect(existsSync(to)).toBe(false);
  });

  it('rejects moving a path onto itself', async () => {
    const filePath = join(tempDir, 'same.txt');
    await Bun.write(filePath, 'keep me');

    await expect(executeMoveFile({ from: filePath, to: filePath }, makeContext())).rejects.toThrow(
      'Source and destination must be different paths'
    );
    expect(await Bun.file(filePath).text()).toBe('keep me');
  });

  it('never moves directories', async () => {
    const from = join(tempDir, 'directory');
    const to = join(tempDir, 'moved-directory');
    mkdirSync(from);

    await expect(executeMoveFile({ from, to }, makeContext())).rejects.toThrow(
      'it is not a regular file'
    );
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  it('never follows and moves symbolic links', async () => {
    if (process.platform === 'win32') return;
    const target = join(tempDir, 'target.txt');
    const from = join(tempDir, 'link.txt');
    const to = join(tempDir, 'moved.txt');
    await Bun.write(target, 'keep me');
    symlinkSync(target, from);

    await expect(executeMoveFile({ from, to }, makeContext())).rejects.toThrow(
      'symbolic links are not supported'
    );
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(await Bun.file(target).text()).toBe('keep me');
  });

  it('applies allowlists to both source and destination', async () => {
    const from = join(tempDir, 'source.txt');
    const outsideDir = mkdtempSync(join(tmpdir(), 'move-file-allowlist-'));
    const to = join(outsideDir, 'destination.txt');
    await Bun.write(from, 'keep me');

    try {
      await expect(
        executeMoveFile({ from, to }, makeContext({ allowedPaths: [tempDir] }))
      ).rejects.toThrow('not in the allowed paths');
      expect(await Bun.file(from).text()).toBe('keep me');
      expect(existsSync(to)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('applies denylists to both source and destination', async () => {
    const sourceDir = join(tempDir, 'source');
    const destinationDir = join(tempDir, 'destination');
    mkdirSync(sourceDir);
    const from = join(sourceDir, 'file.txt');
    const to = join(destinationDir, 'file.txt');
    await Bun.write(from, 'keep me');

    await expect(
      executeMoveFile({ from, to }, makeContext({ deniedPaths: [sourceDir] }))
    ).rejects.toThrow('in the denied paths');
    await expect(
      executeMoveFile({ from, to }, makeContext({ deniedPaths: [destinationDir] }))
    ).rejects.toThrow('in the denied paths');
    expect(await Bun.file(from).text()).toBe('keep me');
    expect(existsSync(to)).toBe(false);
  });

  it('enforces restricted workdir containment on both paths', async () => {
    const from = join(tempDir, 'source.txt');
    const outsideDir = mkdtempSync(join(tmpdir(), 'move-file-outside-'));
    const to = join(outsideDir, 'destination.txt');
    await Bun.write(from, 'keep me');

    try {
      await expect(
        executeMoveFile(
          { from, to },
          {
            ...makeContext(),
            workdir: tempDir,
            workdirPolicy: { root: tempDir, restricted: true },
          }
        )
      ).rejects.toThrow('outside the chat working directory');
      expect(await Bun.file(from).text()).toBe('keep me');
      expect(existsSync(to)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('serializes parallel moves to one destination without clobbering', async () => {
    const first = join(tempDir, 'first.txt');
    const second = join(tempDir, 'second.txt');
    const destination = join(tempDir, 'destination.txt');
    await Bun.write(first, 'first');
    await Bun.write(second, 'second');

    const results = await Promise.allSettled([
      executeMoveFile({ from: first, to: destination }, makeContext()),
      executeMoveFile({ from: second, to: destination }, makeContext()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await Bun.file(destination).text()).toBe('first');
    expect(existsSync(first)).toBe(false);
    expect(await Bun.file(second).text()).toBe('second');
  });
});
