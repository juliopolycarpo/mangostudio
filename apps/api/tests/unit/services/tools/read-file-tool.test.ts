import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  executeReadFile,
  normalizeReadFileToolSettings,
} from '../../../../src/services/tools/builtin/read-file';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'read-file-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

describe('normalizeReadFileToolSettings', () => {
  it('returns empty arrays by default', () => {
    const settings = normalizeReadFileToolSettings({});
    expect(settings.allowedPaths).toEqual([]);
    expect(settings.deniedPaths).toEqual([]);
  });

  it('normalizes string list parameters', () => {
    const settings = normalizeReadFileToolSettings({
      allowedPaths: ['/home', '/tmp'],
      deniedPaths: '/etc\n/root',
    });
    expect(settings.allowedPaths).toEqual(['/home', '/tmp']);
    expect(settings.deniedPaths).toEqual(['/etc', '/root']);
  });
});

describe('executeReadFile', () => {
  it('reads a text file and returns its content and size', async () => {
    const filePath = join(tempDir, 'hello.txt');
    writeFileSync(filePath, 'Hello, world!', 'utf-8');

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.path).toBe(filePath);
    expect(result.content).toBe('Hello, world!');
    expect(result.size).toBe(13);
  });

  it('expands ~ to home directory', async () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;

    const filePath = join(tempDir, 'home-test.txt');
    writeFileSync(filePath, 'home content', 'utf-8');

    // Mock home to tempDir for this test
    const originalHome = Bun.env.HOME;
    Bun.env.HOME = tempDir;
    try {
      const result = await executeReadFile({ path: '~/home-test.txt' }, makeContext());
      expect(result.content).toBe('home content');
    } finally {
      Bun.env.HOME = originalHome;
    }
  });

  it('throws when file does not exist', async () => {
    const filePath = join(tempDir, 'missing.txt');

    let threw = false;
    try {
      await executeReadFile({ path: filePath }, makeContext());
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('not found');
    }
    expect(threw).toBe(true);
  });

  it('throws when path is outside allowed paths', async () => {
    const filePath = join(tempDir, 'secret.txt');
    writeFileSync(filePath, 'secret', 'utf-8');

    let threw = false;
    try {
      await executeReadFile({ path: filePath }, makeContext({ allowedPaths: ['/other'] }));
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('not in the allowed paths');
    }
    expect(threw).toBe(true);
  });

  it('throws when path is inside denied paths', async () => {
    const filePath = join(tempDir, 'secret.txt');
    writeFileSync(filePath, 'secret', 'utf-8');

    let threw = false;
    try {
      await executeReadFile({ path: filePath }, makeContext({ deniedPaths: [tempDir] }));
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('in the denied paths');
    }
    expect(threw).toBe(true);
  });

  it('allows reading when path is in allowed list', async () => {
    const filePath = join(tempDir, 'allowed.txt');
    writeFileSync(filePath, 'allowed content', 'utf-8');

    const result = await executeReadFile(
      { path: filePath },
      makeContext({ allowedPaths: [tempDir] })
    );
    expect(result.content).toBe('allowed content');
  });
});
