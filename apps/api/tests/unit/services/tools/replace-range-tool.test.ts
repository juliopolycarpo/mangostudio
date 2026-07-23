import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import {
  executeReplaceRange,
  normalizeReplaceRangeToolSettings,
  register as registerReplaceRangeTool,
} from '../../../../src/services/tools/builtin/replace-range';
import {
  clearFileFreshness,
  FileNotReadError,
  StaleFileError,
} from '../../../../src/services/tools/file-freshness';
import { executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  registerReplaceRangeTool();
  tempDir = mkdtempSync(join(tmpdir(), 'replace-range-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

async function seedAndRead(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  await executeReadFile({ path: filePath }, makeContext());
  return filePath;
}

describe('normalizeReplaceRangeToolSettings', () => {
  it('normalizes current and legacy path lists', () => {
    expect(normalizeReplaceRangeToolSettings({})).toEqual({
      allowedPaths: [],
      deniedPaths: [],
    });
    expect(
      normalizeReplaceRangeToolSettings({
        allowedPaths: [{ path: '/home', enabled: true }],
        deniedPaths: '/etc\n/root',
      })
    ).toEqual({
      allowedPaths: [{ path: '/home', enabled: true }],
      deniedPaths: [
        { path: '/etc', enabled: true },
        { path: '/root', enabled: true },
      ],
    });
  });
});

describe('executeReplaceRange', () => {
  it.each([
    ['first', 1, 1, 'ONE', 'ONE\ntwo\nthree\n'],
    ['middle', 2, 2, 'TWO', 'one\nTWO\nthree\n'],
    ['last', 3, 3, 'THREE', 'one\ntwo\nTHREE\n'],
  ])('replaces the %s line inclusively', async (_position, startLine, endLine, content, expected) => {
    const filePath = await seedAndRead(`${_position}.txt`, 'one\ntwo\nthree\n');

    const result = await executeReplaceRange(
      { path: filePath, startLine, endLine, content },
      makeContext()
    );

    expect(result.replacedLines).toBe(1);
    expect(result.newTotalLines).toBe(3);
    expect(result.sha256).toHaveLength(64);
    expect(await Bun.file(filePath).text()).toBe(expected);
  });

  it('grows and shrinks the number of lines', async () => {
    const filePath = await seedAndRead('resize.txt', 'one\ntwo\nthree\nfour');

    const grown = await executeReplaceRange(
      { path: filePath, startLine: 2, endLine: 2, content: 'two-a\ntwo-b\ntwo-c' },
      makeContext()
    );
    expect(grown).toMatchObject({ replacedLines: 1, newTotalLines: 6 });

    const shrunk = await executeReplaceRange(
      { path: filePath, startLine: 2, endLine: 5, content: 'middle' },
      makeContext()
    );
    expect(shrunk).toMatchObject({ replacedLines: 4, newTotalLines: 3 });
    expect(await Bun.file(filePath).text()).toBe('one\nmiddle\nfour');
  });

  it('deletes a range when content is empty', async () => {
    const filePath = await seedAndRead('delete.txt', 'one\ntwo\nthree\nfour\n');

    const result = await executeReplaceRange(
      { path: filePath, startLine: 2, endLine: 3, content: '' },
      makeContext()
    );

    expect(result).toMatchObject({ replacedLines: 2, newTotalLines: 2 });
    expect(await Bun.file(filePath).text()).toBe('one\nfour\n');
  });

  it('preserves the final newline when deleting every logical line', async () => {
    const filePath = await seedAndRead('delete-all.txt', 'one\ntwo\n');

    const result = await executeReplaceRange(
      { path: filePath, startLine: 1, endLine: 2, content: '' },
      makeContext()
    );

    expect(result.newTotalLines).toBe(1);
    expect(await Bun.file(filePath).text()).toBe('\n');
  });

  it('preserves whether the source ends with a final newline', async () => {
    const withNewline = await seedAndRead('with-newline.txt', 'one\ntwo\n');
    const withoutNewline = await seedAndRead('without-newline.txt', 'one\ntwo');

    await executeReplaceRange(
      { path: withNewline, startLine: 2, endLine: 2, content: 'TWO' },
      makeContext()
    );
    await executeReplaceRange(
      { path: withoutNewline, startLine: 2, endLine: 2, content: 'TWO\n' },
      makeContext()
    );

    expect(await Bun.file(withNewline).text()).toBe('one\nTWO\n');
    expect(await Bun.file(withoutNewline).text()).toBe('one\nTWO');
  });

  it('round-trips untouched CRLF line endings', async () => {
    const filePath = await seedAndRead('crlf.txt', 'one\r\ntwo\r\nthree\r\n');

    await executeReplaceRange(
      { path: filePath, startLine: 2, endLine: 2, content: 'TWO\r' },
      makeContext()
    );

    expect(await Bun.file(filePath).bytes()).toEqual(
      new TextEncoder().encode('one\r\nTWO\r\nthree\r\n')
    );
  });

  it('reports actual line totals for invalid ranges', async () => {
    const filePath = await seedAndRead('bounds.txt', 'one\ntwo\nthree');

    for (const range of [
      { startLine: 0, endLine: 1 },
      { startLine: 2, endLine: 1 },
      { startLine: 1, endLine: 4 },
    ]) {
      await expect(
        executeReplaceRange({ path: filePath, ...range, content: 'x' }, makeContext())
      ).rejects.toThrow(
        `Invalid line range ${range.startLine}-${range.endLine} for "${filePath}" (3 lines). Expected 1 <= startLine <= endLine <= 3.`
      );
    }
    expect(await Bun.file(filePath).text()).toBe('one\ntwo\nthree');
  });

  it('leaves unread and stale files untouched', async () => {
    const unreadPath = join(tempDir, 'unread.txt');
    await Bun.write(unreadPath, 'one\ntwo');
    await expect(
      executeReplaceRange(
        { path: unreadPath, startLine: 1, endLine: 1, content: 'ONE' },
        makeContext()
      )
    ).rejects.toBeInstanceOf(FileNotReadError);
    expect(await Bun.file(unreadPath).text()).toBe('one\ntwo');

    const stalePath = await seedAndRead('stale.txt', 'one\ntwo');
    await Bun.write(stalePath, 'changed outside the tool');
    await expect(
      executeReplaceRange(
        { path: stalePath, startLine: 1, endLine: 1, content: 'ONE' },
        makeContext()
      )
    ).rejects.toBeInstanceOf(StaleFileError);
    expect(await Bun.file(stalePath).text()).toBe('changed outside the tool');
  });

  it('rejects a file that was only partially read', async () => {
    const content = 'line 1\nline 2\nline 3';
    const filePath = join(tempDir, 'partial.txt');
    await Bun.write(filePath, content);
    await executeReadFile({ path: filePath, maxLines: 1 }, makeContext());

    await expect(
      executeReplaceRange(
        { path: filePath, startLine: 1, endLine: 1, content: 'first line' },
        makeContext()
      )
    ).rejects.toThrow('only lines 1-1 have been read');
    expect(await Bun.file(filePath).text()).toBe(content);
  });

  it('allows sequential ranges after one read', async () => {
    const filePath = await seedAndRead('sequential.txt', 'one\ntwo\nthree');

    await executeReplaceRange(
      { path: filePath, startLine: 1, endLine: 1, content: 'ONE' },
      makeContext()
    );
    await executeReplaceRange(
      { path: filePath, startLine: 3, endLine: 3, content: 'THREE' },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('ONE\ntwo\nTHREE');
  });

  it('enforces path policy before modifying the file', async () => {
    const filePath = await seedAndRead('blocked.txt', 'keep');

    await expect(
      executeReplaceRange(
        { path: filePath, startLine: 1, endLine: 1, content: 'nope' },
        makeContext({ deniedPaths: [tempDir] })
      )
    ).rejects.toThrow('in the denied paths');
    expect(await Bun.file(filePath).text()).toBe('keep');
  });
});

describe('replace_range argument handling', () => {
  it('preserves replacement content supplied through the registry', async () => {
    const filePath = await seedAndRead('verbatim.txt', 'one\ntwo\n');

    await executeTool(
      'replace_range',
      { path: filePath, startLine: 2, endLine: 2, content: 'TWO\nTHREE\n' },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('one\nTWO\nTHREE\n');
  });

  it('rejects non-integer line numbers and non-string content', async () => {
    const filePath = await seedAndRead('raw-invalid.txt', 'keep');

    await expect(
      executeTool(
        'replace_range',
        { path: filePath, startLine: 1.5, endLine: 1, content: 'nope' },
        makeContext()
      )
    ).rejects.toThrow('Field "startLine" must be an integer');
    await expect(
      executeTool(
        'replace_range',
        { path: filePath, startLine: 1, endLine: 1, content: 42 },
        makeContext()
      )
    ).rejects.toThrow('Field "content" must be a string');
    expect(await Bun.file(filePath).text()).toBe('keep');
  });
});
