import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  executeListDirectory,
  normalizeListDirectoryToolSettings,
} from '../../../../src/services/tools/builtin/list-directory';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'list-dir-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

describe('normalizeListDirectoryToolSettings', () => {
  it('returns empty arrays by default', () => {
    const settings = normalizeListDirectoryToolSettings({});
    expect(settings.allowedPaths).toEqual([]);
    expect(settings.deniedPaths).toEqual([]);
  });

  it('normalizes string list parameters', () => {
    const settings = normalizeListDirectoryToolSettings({
      allowedPaths: ['/home', '/tmp'],
      deniedPaths: '/etc\n/root',
    });
    expect(settings.allowedPaths).toEqual(['/home', '/tmp']);
    expect(settings.deniedPaths).toEqual(['/etc', '/root']);
  });
});

describe('executeListDirectory', () => {
  it('lists files and directories', async () => {
    writeFileSync(join(tempDir, 'file-a.txt'), 'a', 'utf-8');
    writeFileSync(join(tempDir, 'file-b.txt'), 'b', 'utf-8');
    mkdirSync(join(tempDir, 'sub-dir'));

    const result = await executeListDirectory({ path: tempDir }, makeContext());

    expect(result.path).toBe(tempDir);
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(['file-a.txt', 'file-b.txt', 'sub-dir']);

    const subDirEntry = result.entries.find((e) => e.name === 'sub-dir');
    expect(subDirEntry?.type).toBe('directory');

    const fileEntry = result.entries.find((e) => e.name === 'file-a.txt');
    expect(fileEntry?.type).toBe('file');
  });

  it('throws when directory does not exist', async () => {
    const dirPath = join(tempDir, 'missing');

    let threw = false;
    try {
      await executeListDirectory({ path: dirPath }, makeContext());
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('Cannot list');
    }
    expect(threw).toBe(true);
  });

  it('throws when path is outside allowed paths', async () => {
    let threw = false;
    try {
      await executeListDirectory({ path: tempDir }, makeContext({ allowedPaths: ['/other'] }));
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('not in the allowed paths');
    }
    expect(threw).toBe(true);
  });

  it('throws when path is inside denied paths', async () => {
    let threw = false;
    try {
      await executeListDirectory({ path: tempDir }, makeContext({ deniedPaths: [tempDir] }));
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('in the denied paths');
    }
    expect(threw).toBe(true);
  });

  it('allows listing when path is in allowed list', async () => {
    writeFileSync(join(tempDir, 'allowed.txt'), 'content', 'utf-8');

    const result = await executeListDirectory(
      { path: tempDir },
      makeContext({ allowedPaths: [tempDir] })
    );
    expect(result.entries.some((e) => e.name === 'allowed.txt')).toBe(true);
  });

  it('expands ~ to home directory', async () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;

    mkdirSync(join(tempDir, 'home-sub'));

    const originalHome = Bun.env.HOME;
    Bun.env.HOME = tempDir;
    try {
      const result = await executeListDirectory({ path: '~/' }, makeContext());
      expect(result.entries.some((e) => e.name === 'home-sub')).toBe(true);
    } finally {
      Bun.env.HOME = originalHome;
    }
  });
});
