import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeWriteFile,
  normalizeWriteFileToolSettings,
} from '../../../../src/services/tools/builtin/write-file';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'write-file-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

function readBack(filePath: string): Promise<string> {
  return Bun.file(filePath).text();
}

function seedFile(filePath: string, content: string): Promise<number> {
  return Bun.write(filePath, content);
}

describe('normalizeWriteFileToolSettings', () => {
  it('returns empty arrays by default', () => {
    const settings = normalizeWriteFileToolSettings({});
    expect(settings.allowedPaths).toEqual([]);
    expect(settings.deniedPaths).toEqual([]);
  });

  it('normalizes path list parameters', () => {
    const settings = normalizeWriteFileToolSettings({
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
    const settings = normalizeWriteFileToolSettings({
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

describe('executeWriteFile', () => {
  it('writes a relative path inside the chat workdir', async () => {
    const filePath = join(tempDir, 'src', 'index.ts');

    const result = await executeWriteFile(
      { path: 'src/index.ts', content: 'export const value = 1;' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result.path).toBe('src/index.ts');
    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe('export const value = 1;');
  });

  it('rejects a relative path without a workdir before writing anything', async () => {
    const relativePath = `write-file-no-workdir-${crypto.randomUUID()}/index.ts`;
    const processRelativePath = join(process.cwd(), relativePath);

    await expect(
      executeWriteFile({ path: relativePath, content: 'must not be written' }, makeContext())
    ).rejects.toThrow('no working directory is bound to this chat');
    expect(existsSync(processRelativePath)).toBe(false);
  });

  it('writes content to a new file and returns created=true', async () => {
    const filePath = join(tempDir, 'hello.txt');

    const result = await executeWriteFile(
      { path: filePath, content: 'Hello, world!' },
      makeContext()
    );

    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBe(13);
    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe('Hello, world!');
  });

  it('overwrites an existing file and returns created=false', async () => {
    const filePath = join(tempDir, 'existing.txt');
    await seedFile(filePath, 'old content');

    const result = await executeWriteFile(
      { path: filePath, content: 'new content' },
      makeContext()
    );

    expect(result.path).toBe(filePath);
    expect(result.created).toBe(false);
    expect(result.bytesWritten).toBe(11);
    expect(await readBack(filePath)).toBe('new content');
  });

  it('creates parent directories when they do not exist', async () => {
    const filePath = join(tempDir, 'deep', 'nested', 'dir', 'file.txt');

    const result = await executeWriteFile(
      { path: filePath, content: 'nested content' },
      makeContext()
    );

    expect(result.created).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(await readBack(filePath)).toBe('nested content');
  });

  it('writes empty content', async () => {
    const filePath = join(tempDir, 'empty.txt');

    const result = await executeWriteFile({ path: filePath, content: '' }, makeContext());

    expect(result.bytesWritten).toBe(0);
    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe('');
  });

  it('writes unicode content correctly', async () => {
    const filePath = join(tempDir, 'unicode.txt');
    const content = 'Olá mundo! 🌍 こんにちは';

    const result = await executeWriteFile({ path: filePath, content }, makeContext());

    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe(content);
  });

  it('writes multiline content', async () => {
    const filePath = join(tempDir, 'multiline.txt');
    const content = 'line 1\nline 2\nline 3\n';

    const result = await executeWriteFile({ path: filePath, content }, makeContext());

    expect(await readBack(filePath)).toBe(content);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  it('expands ~ to home directory', async () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;

    const originalHome = Bun.env.HOME;
    Bun.env.HOME = tempDir;
    try {
      const result = await executeWriteFile(
        { path: '~/home-write.txt', content: 'home content' },
        makeContext()
      );
      expect(result.created).toBe(true);
      expect(await readBack(join(tempDir, 'home-write.txt'))).toBe('home content');
    } finally {
      Bun.env.HOME = originalHome;
    }
  });

  it('throws when path is outside allowed paths', async () => {
    const filePath = join(tempDir, 'secret.txt');

    let threw = false;
    try {
      await executeWriteFile(
        { path: filePath, content: 'nope' },
        makeContext({ allowedPaths: ['/other'] })
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('not in the allowed paths');
    }
    expect(threw).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('throws when path is inside denied paths', async () => {
    const filePath = join(tempDir, 'denied.txt');

    let threw = false;
    try {
      await executeWriteFile(
        { path: filePath, content: 'nope' },
        makeContext({ deniedPaths: [tempDir] })
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('in the denied paths');
    }
    expect(threw).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('allows writing when path is in allowed list', async () => {
    const filePath = join(tempDir, 'allowed.txt');

    const result = await executeWriteFile(
      { path: filePath, content: 'allowed content' },
      makeContext({ allowedPaths: [tempDir] })
    );
    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe('allowed content');
  });

  it('ignores disabled allowed paths', async () => {
    const filePath = join(tempDir, 'disabled-allowed.txt');

    let threw = false;
    try {
      await executeWriteFile(
        { path: filePath, content: 'nope' },
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
    const filePath = join(tempDir, 'disabled-denied.txt');

    const result = await executeWriteFile(
      { path: filePath, content: 'content' },
      makeContext({
        deniedPaths: [
          { path: '/other', enabled: true },
          { path: tempDir, enabled: false },
        ],
      })
    );
    expect(result.created).toBe(true);
  });

  it('writes to an existing directory without creating it', async () => {
    const subDir = join(tempDir, 'existing-dir');
    mkdirSync(subDir);
    const filePath = join(subDir, 'file.txt');

    const result = await executeWriteFile(
      { path: filePath, content: 'in existing dir' },
      makeContext()
    );

    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe('in existing dir');
  });
});
