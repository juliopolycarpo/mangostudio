import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countTotalLines,
  executeReadFile,
  findWindowByteRange,
  looksBinary,
  normalizeReadFileToolSettings,
  READ_FILE_MAX_LINE_CHARS,
  READ_FILE_MAX_WINDOW_BYTES,
} from '../../../../src/services/tools/builtin/read-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'read-file-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

function seedFile(filePath: string, content: string | Uint8Array): Promise<number> {
  return Bun.write(filePath, content);
}

function numbered(line: number, body: string): string {
  return `${String(line).padStart(6, ' ')}\t${body}`;
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

describe('countTotalLines / looksBinary / findWindowByteRange', () => {
  it('counts empty, newline-only, and trailing-newline files', () => {
    expect(countTotalLines(new Uint8Array())).toBe(0);
    expect(countTotalLines(new TextEncoder().encode('\n'))).toBe(1);
    expect(countTotalLines(new TextEncoder().encode('a\nb\n'))).toBe(2);
    expect(countTotalLines(new TextEncoder().encode('a\nb'))).toBe(2);
  });

  it('detects a NUL byte in the first 8 KiB as binary', () => {
    expect(looksBinary(new Uint8Array([0x00, 0x01]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false);
  });

  it('finds inclusive window byte ranges', () => {
    const bytes = new TextEncoder().encode('one\ntwo\nthree');
    expect(findWindowByteRange(bytes, 2, 2)).toEqual({ start: 4, end: 8 });
    expect(findWindowByteRange(bytes, 1, 3)).toEqual({ start: 0, end: 13 });
  });

  it('returns an empty range for an inverted window instead of the rest of the file', () => {
    const bytes = new TextEncoder().encode('one\ntwo\nthree');
    expect(findWindowByteRange(bytes, 2, 1)).toEqual({ start: 4, end: 4 });
    expect(findWindowByteRange(bytes, 1, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('executeReadFile', () => {
  it('reads a relative path from the chat workdir', async () => {
    const filePath = join(tempDir, 'src', 'index.ts');
    mkdirSync(join(tempDir, 'src'));
    await seedFile(filePath, 'export const value = 1;');

    const result = await executeReadFile(
      { path: 'src/index.ts' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result.path).toBe('src/index.ts');
    expect(result.content).toBe(numbered(1, 'export const value = 1;'));
    expect(result.totalLines).toBe(1);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('rejects a relative path when no chat workdir is available', async () => {
    await expect(executeReadFile({ path: 'src/index.ts' }, makeContext())).rejects.toThrow(
      'no working directory is bound to this chat'
    );
  });

  it('rejects paths outside the workdir when restriction is enabled', async () => {
    const filePath = join(tempDir, 'inside.txt');
    await seedFile(filePath, 'ok');
    // mkdtemp (not join(tmpdir(), fixedName)) avoids CodeQL js/insecure-temporary-file.
    const outsideDir = mkdtempSync(join(tmpdir(), 'outside-read-'));
    try {
      const outsidePath = join(outsideDir, 'outside-read.txt');

      await expect(
        executeReadFile(
          { path: outsidePath },
          {
            ...makeContext(),
            workdir: tempDir,
            workdirPolicy: { root: tempDir, restricted: true },
          }
        )
      ).rejects.toThrow('outside the chat working directory');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('returns cat -n numbered content with exact tab alignment', async () => {
    const filePath = join(tempDir, 'hello.txt');
    await seedFile(filePath, 'alpha\nbeta\ngamma');

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.content).toBe(
      [numbered(1, 'alpha'), numbered(2, 'beta'), numbered(3, 'gamma')].join('\n')
    );
    expect(result.size).toBe(Buffer.byteLength('alpha\nbeta\ngamma'));
    expect(result.sha256).toHaveLength(64);
    expect(result.totalLines).toBe(3);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('reads a text file and returns size plus whole-file sha256', async () => {
    const filePath = join(tempDir, 'single.txt');
    await seedFile(filePath, 'Hello, world!');

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.path).toBe(filePath);
    expect(result.content).toBe(numbered(1, 'Hello, world!'));
    expect(result.size).toBe(13);
    expect(result.sha256).toBe('315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3');
  });

  it('windows with startLine and maxLines and reports endLine/totalLines', async () => {
    const filePath = join(tempDir, 'window.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour\nfive');

    const result = await executeReadFile(
      { path: filePath, startLine: 2, maxLines: 2 },
      makeContext()
    );

    expect(result.content).toBe(
      `${[numbered(2, 'two'), numbered(3, 'three')].join('\n')}\n\n[truncated: use startLine/maxLines to read more]`
    );
    expect(result.totalLines).toBe(5);
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('clamps the window at EOF without a truncation notice when fully covered', async () => {
    const filePath = join(tempDir, 'eof.txt');
    await seedFile(filePath, 'one\ntwo\nthree');

    const result = await executeReadFile(
      { path: filePath, startLine: 2, maxLines: 50 },
      makeContext()
    );

    expect(result.content).toBe([numbered(2, 'two'), numbered(3, 'three')].join('\n'));
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('returns an empty window for an empty file', async () => {
    const filePath = join(tempDir, 'empty.txt');
    await seedFile(filePath, '');

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.content).toBe('');
    expect(result.totalLines).toBe(0);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.size).toBe(0);
  });

  it('rejects startLine past EOF', async () => {
    const filePath = join(tempDir, 'short.txt');
    await seedFile(filePath, 'only\ntwo');

    await expect(executeReadFile({ path: filePath, startLine: 5 }, makeContext())).rejects.toThrow(
      'startLine 5 is past the end'
    );
  });

  it('truncates long lines with an inline marker and sets truncated', async () => {
    const filePath = join(tempDir, 'long-line.txt');
    const long = 'x'.repeat(READ_FILE_MAX_LINE_CHARS + 50);
    await seedFile(filePath, long);

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('…[truncated]');
    expect(result.content).toContain('[truncated: use startLine/maxLines to read more]');
    expect(result.content).toContain(
      numbered(1, `${'x'.repeat(READ_FILE_MAX_LINE_CHARS)}…[truncated]`)
    );
  });

  it('never cuts a surrogate pair in half when truncating a long line', async () => {
    const filePath = join(tempDir, 'surrogate.txt');
    // The cap lands between the two code units of the first emoji.
    await seedFile(filePath, `${'a'.repeat(READ_FILE_MAX_LINE_CHARS - 1)}${'🎉'.repeat(4)}`);

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.truncated).toBe(true);
    expect(result.content).toBe(
      `${numbered(1, `${'a'.repeat(READ_FILE_MAX_LINE_CHARS - 1)}…[truncated]`)}${'\n\n[truncated: use startLine/maxLines to read more]'}`
    );
    expect(result.content).toBe(JSON.parse(JSON.stringify(result.content)));
    expect(new TextDecoder().decode(new TextEncoder().encode(result.content))).toBe(result.content);
  });

  it('stops early when the window byte cap is exceeded', async () => {
    const filePath = join(tempDir, 'byte-cap.txt');
    // Keep each raw line under the per-line char cap so only the window byte
    // budget can trip truncation.
    const lineBody = 'y'.repeat(1800);
    const numberedBytesApprox = 7 + 1800; // padStart(6)+tab+body
    const lineCount = Math.ceil(READ_FILE_MAX_WINDOW_BYTES / numberedBytesApprox) + 5;
    await seedFile(filePath, Array.from({ length: lineCount }, () => lineBody).join('\n'));

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.truncated).toBe(true);
    expect(result.endLine).toBeLessThan(lineCount);
    expect(result.content).toContain('[truncated: use startLine/maxLines to read more]');
    expect(result.content).not.toContain('…[truncated]');
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      READ_FILE_MAX_WINDOW_BYTES + 80
    );
  });

  it('rejects binary files with a clear error', async () => {
    const filePath = join(tempDir, 'image.bin');
    await seedFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));

    await expect(executeReadFile({ path: filePath }, makeContext())).rejects.toThrow(
      /appears to be a binary file/
    );
  });

  it('preserves UTF-8 multibyte content through numbering', async () => {
    const filePath = join(tempDir, 'utf8.txt');
    await seedFile(filePath, 'café\n日本語\n🎉');

    const result = await executeReadFile({ path: filePath }, makeContext());

    expect(result.content).toBe(
      [numbered(1, 'café'), numbered(2, '日本語'), numbered(3, '🎉')].join('\n')
    );
    expect(result.totalLines).toBe(3);
  });

  it('records whole-file sha256 on a windowed read so a later write stays fresh', async () => {
    const filePath = join(tempDir, 'fresh.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour');

    const read = await executeReadFile(
      { path: filePath, startLine: 2, maxLines: 1 },
      makeContext()
    );
    expect(read.endLine).toBe(2);
    expect(read.sha256).toHaveLength(64);

    const written = await executeWriteFile(
      { path: filePath, content: 'replaced\n' },
      makeContext()
    );
    expect(written.created).toBe(false);
    expect(await Bun.file(filePath).text()).toBe('replaced\n');
  });

  it('expands ~ to home directory', async () => {
    const home = Bun.env.HOME ?? '';
    if (!home) return;

    const filePath = join(tempDir, 'home-test.txt');
    await seedFile(filePath, 'home content');

    const originalHome = Bun.env.HOME;
    Bun.env.HOME = tempDir;
    try {
      const result = await executeReadFile({ path: '~/home-test.txt' }, makeContext());
      expect(result.content).toBe(numbered(1, 'home content'));
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

  it('throws when the path is a directory', async () => {
    const dirPath = join(tempDir, 'a-directory');
    mkdirSync(dirPath);

    await expect(executeReadFile({ path: dirPath }, makeContext())).rejects.toThrow(
      'not a regular file'
    );
  });

  it('throws when path is outside allowed paths', async () => {
    const filePath = join(tempDir, 'secret.txt');
    await seedFile(filePath, 'secret');

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
    await seedFile(filePath, 'secret');

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
    await seedFile(filePath, 'allowed content');

    const result = await executeReadFile(
      { path: filePath },
      makeContext({ allowedPaths: [tempDir] })
    );
    expect(result.content).toBe(numbered(1, 'allowed content'));
  });

  it('ignores disabled allowed paths', async () => {
    const filePath = join(tempDir, 'disabled-allowed.txt');
    await seedFile(filePath, 'content');

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
    await seedFile(filePath, 'content');

    const result = await executeReadFile(
      { path: filePath },
      makeContext({
        deniedPaths: [
          { path: '/other', enabled: true },
          { path: tempDir, enabled: false },
        ],
      })
    );
    expect(result.content).toBe(numbered(1, 'content'));
  });
});
