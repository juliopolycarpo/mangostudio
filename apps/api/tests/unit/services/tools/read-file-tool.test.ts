import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  it('normalizes path list parameters', () => {
    const settings = normalizeReadFileToolSettings({
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
    const settings = normalizeReadFileToolSettings({
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

  it('ignores disabled allowed paths', async () => {
    const filePath = join(tempDir, 'disabled-allowed.txt');
    writeFileSync(filePath, 'content', 'utf-8');

    let threw = false;
    try {
      await executeReadFile(
        { path: filePath },
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
    writeFileSync(filePath, 'content', 'utf-8');

    const result = await executeReadFile(
      { path: filePath },
      makeContext({
        deniedPaths: [
          { path: '/other', enabled: true },
          { path: tempDir, enabled: false },
        ],
      })
    );
    expect(result.content).toBe('content');
  });
});
