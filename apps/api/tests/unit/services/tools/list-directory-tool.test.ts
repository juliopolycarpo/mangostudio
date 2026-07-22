import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function seedFile(filePath: string, content: string): Promise<number> {
  return Bun.write(filePath, content);
}

describe('normalizeListDirectoryToolSettings', () => {
  it('returns empty arrays by default', () => {
    const settings = normalizeListDirectoryToolSettings({});
    expect(settings.allowedPaths).toEqual([]);
    expect(settings.deniedPaths).toEqual([]);
  });

  it('normalizes path list parameters', () => {
    const settings = normalizeListDirectoryToolSettings({
      allowedPaths: [
        { path: '/home', enabled: true },
        { path: '/tmp', enabled: false },
      ],
      deniedPaths: [
        { path: '/etc', enabled: true },
        { path: '/root', enabled: true },
      ],
    });
    expect(settings.allowedPaths).toEqual([
      { path: '/home', enabled: true },
      { path: '/tmp', enabled: false },
    ]);
    expect(settings.deniedPaths).toEqual([
      { path: '/etc', enabled: true },
      { path: '/root', enabled: true },
    ]);
  });

  it('normalizes legacy string list parameters for backward compatibility', () => {
    const settings = normalizeListDirectoryToolSettings({
      allowedPaths: ['/home', '/tmp'],
      deniedPaths: '/etc\n/root',
    });
    expect(settings.allowedPaths).toEqual([
      { path: '/home', enabled: true },
      { path: '/tmp', enabled: true },
    ]);
    expect(settings.deniedPaths).toEqual([
      { path: '/etc', enabled: true },
      { path: '/root', enabled: true },
    ]);
  });
});

describe('executeListDirectory', () => {
  it('lists files and directories', async () => {
    await seedFile(join(tempDir, 'file-a.txt'), 'a');
    await seedFile(join(tempDir, 'file-b.txt'), 'b');
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

  it('uses the chat workdir when path is omitted', async () => {
    await seedFile(join(tempDir, 'workdir-file.txt'), 'content');

    const result = await executeListDirectory({}, { ...makeContext(), workdir: tempDir });

    expect(result.path).toBe(tempDir);
    expect(result.entries.some((entry) => entry.name === 'workdir-file.txt')).toBe(true);
  });

  it('resolves an explicit relative path from the chat workdir', async () => {
    const nested = join(tempDir, 'src');
    mkdirSync(nested);
    await seedFile(join(nested, 'index.ts'), 'content');

    const result = await executeListDirectory(
      { path: 'src' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result.path).toBe('src');
    expect(result.entries).toEqual([{ name: 'index.ts', type: 'file' }]);
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
    await seedFile(join(tempDir, 'allowed.txt'), 'content');

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

  it('ignores disabled allowed paths', async () => {
    let threw = false;
    try {
      await executeListDirectory(
        { path: tempDir },
        makeContext({
          allowedPaths: [
            { path: '/other', enabled: true },
            { path: tempDir, enabled: false },
          ],
        })
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('not in the allowed paths');
    }
    expect(threw).toBe(true);
  });

  it('ignores disabled denied paths', async () => {
    await seedFile(join(tempDir, 'disabled-denied.txt'), 'content');

    const result = await executeListDirectory(
      { path: tempDir },
      makeContext({
        deniedPaths: [
          { path: '/other', enabled: true },
          { path: tempDir, enabled: false },
        ],
      })
    );
    expect(result.entries.some((e) => e.name === 'disabled-denied.txt')).toBe(true);
  });
});
