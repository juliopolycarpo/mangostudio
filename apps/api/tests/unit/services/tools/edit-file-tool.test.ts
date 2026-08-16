import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeEditFile,
  normalizeEditFileToolSettings,
  register as registerEditFileTool,
} from '../../../../src/services/tools/builtin/edit-file';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
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
  registerEditFileTool();
  tempDir = mkdtempSync(join(tmpdir(), 'edit-file-test-'));
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

describe('normalizeEditFileToolSettings', () => {
  it('normalizes current and legacy path lists', () => {
    expect(normalizeEditFileToolSettings({})).toEqual({
      allowedPaths: [],
      deniedPaths: [],
    });
    expect(
      normalizeEditFileToolSettings({
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

describe('executeEditFile', () => {
  it('replaces one exact occurrence and reports the resulting digest', async () => {
    const filePath = await seedAndRead('unique.txt', 'alpha\nbeta\ngamma\n');

    const result = await executeEditFile(
      { path: filePath, oldString: 'beta', newString: 'delta' },
      makeContext()
    );

    expect(result).toEqual({
      path: filePath,
      replacements: 1,
      sha256: '470450d1505afcca08475704dab5c5492116b66a896663fc0741a9c0982fd7b5',
      firstChangedLine: 2,
    });
    expect(await Bun.file(filePath).text()).toBe('alpha\ndelta\ngamma\n');
  });

  it('replaces every non-overlapping occurrence when requested', async () => {
    const filePath = await seedAndRead('all.txt', 'red blue red\nred');

    const result = await executeEditFile(
      { path: filePath, oldString: 'red', newString: 'green', replaceAll: true },
      makeContext()
    );

    expect(result.replacements).toBe(3);
    expect(result.firstChangedLine).toBe(1);
    expect(await Bun.file(filePath).text()).toBe('green blue green\ngreen');
  });

  it('uses non-overlapping replaceAll semantics', async () => {
    const filePath = await seedAndRead('overlapping.txt', 'aaaaa');

    const result = await executeEditFile(
      { path: filePath, oldString: 'aa', newString: 'x', replaceAll: true },
      makeContext()
    );

    expect(result.replacements).toBe(2);
    expect(await Bun.file(filePath).text()).toBe('xxa');
  });

  it('rejects a missing exact match with actionable remediation', async () => {
    const filePath = await seedAndRead('missing.txt', 'current content');

    await expect(
      executeEditFile(
        { path: filePath, oldString: 'old content', newString: 'new content' },
        makeContext()
      )
    ).rejects.toThrow(
      `The text to replace was not found in "${filePath}". Re-read the file — it may have changed, or adjust oldString to match exactly (including whitespace).`
    );
    expect(await Bun.file(filePath).text()).toBe('current content');
  });

  it('reports the occurrence count when the match is ambiguous', async () => {
    const filePath = await seedAndRead('ambiguous.txt', 'same same same');

    await expect(
      executeEditFile({ path: filePath, oldString: 'same', newString: 'different' }, makeContext())
    ).rejects.toThrow(
      'Found 3 occurrences. Provide a longer oldString with more surrounding context to make it unique, or set replaceAll: true.'
    );
    expect(await Bun.file(filePath).text()).toBe('same same same');
  });

  it('rejects empty and unchanged replacement requests', async () => {
    const filePath = await seedAndRead('invalid.txt', 'text');

    await expect(
      executeEditFile({ path: filePath, oldString: '', newString: 'new' }, makeContext())
    ).rejects.toThrow('oldString must not be empty');
    await expect(
      executeEditFile({ path: filePath, oldString: 'text', newString: 'text' }, makeContext())
    ).rejects.toThrow('oldString and newString must be different');
    expect(await Bun.file(filePath).text()).toBe('text');
  });

  it('leaves unread and stale files untouched', async () => {
    const unreadPath = join(tempDir, 'unread.txt');
    await Bun.write(unreadPath, 'keep unread');

    await expect(
      executeEditFile({ path: unreadPath, oldString: 'unread', newString: 'safe' }, makeContext())
    ).rejects.toBeInstanceOf(FileNotReadError);
    expect(await Bun.file(unreadPath).text()).toBe('keep unread');

    const stalePath = await seedAndRead('stale.txt', 'observed text');
    await Bun.write(stalePath, 'changed outside the tool');
    await expect(
      executeEditFile(
        { path: stalePath, oldString: 'observed', newString: 'replacement' },
        makeContext()
      )
    ).rejects.toBeInstanceOf(StaleFileError);
    expect(await Bun.file(stalePath).text()).toBe('changed outside the tool');
  });

  it('names the binary blocker instead of demanding an impossible read', async () => {
    const filePath = join(tempDir, 'blob.bin');
    await Bun.write(filePath, new Uint8Array([0x41, 0x00, 0x42]));

    // read_file refuses binary files, so "read it first" would loop forever.
    await expect(executeReadFile({ path: filePath }, makeContext())).rejects.toThrow('binary file');
    const error = (await executeEditFile(
      { path: filePath, oldString: 'A', newString: 'C' },
      makeContext()
    ).catch((thrown: unknown) => thrown)) as Error;

    expect(error).not.toBeInstanceOf(FileNotReadError);
    expect(error.message).toContain('read-before-edit guard cannot be satisfied');
  });

  it('refuses a replacement that would turn a text file binary', async () => {
    const filePath = await seedAndRead('nul.txt', 'hello world\n');

    await expect(
      executeEditFile(
        { path: filePath, oldString: 'world', newString: 'w\u0000rld' },
        makeContext()
      )
    ).rejects.toThrow('newString contains a NUL byte');
    expect(await Bun.file(filePath).text()).toBe('hello world\n');
  });

  it('rejects a file that was only partially read', async () => {
    const content = 'line 1\nline 2\nline 3';
    const filePath = join(tempDir, 'partial.txt');
    await Bun.write(filePath, content);
    await executeReadFile({ path: filePath, maxLines: 1 }, makeContext());

    await expect(
      executeEditFile(
        { path: filePath, oldString: 'line 1', newString: 'first line' },
        makeContext()
      )
    ).rejects.toThrow('only lines 1-1 have been read');
    expect(await Bun.file(filePath).text()).toBe(content);
  });

  it('matches unicode and CRLF content exactly', async () => {
    const filePath = await seedAndRead('unicode-crlf.txt', 'Olá 🌍\r\nsegunda linha\r\n');

    const result = await executeEditFile(
      {
        path: filePath,
        oldString: '🌍\r\nsegunda',
        newString: 'mundo\r\npróxima',
      },
      makeContext()
    );

    expect(result.firstChangedLine).toBe(1);
    expect(await Bun.file(filePath).text()).toBe('Olá mundo\r\npróxima linha\r\n');
  });

  it('allows sequential edits after one read', async () => {
    const filePath = await seedAndRead('sequential.txt', 'one two three');

    await executeEditFile({ path: filePath, oldString: 'one', newString: 'ONE' }, makeContext());
    await executeEditFile(
      { path: filePath, oldString: 'three', newString: 'THREE' },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('ONE two THREE');
  });

  it('anchors relative paths and enforces path policy', async () => {
    const filePath = join(tempDir, 'relative.txt');
    await Bun.write(filePath, 'before');
    const context = { ...makeContext(), workdir: tempDir };
    await executeReadFile({ path: 'relative.txt' }, context);

    const result = await executeEditFile(
      { path: 'relative.txt', oldString: 'before', newString: 'after' },
      context
    );

    expect(result.path).toBe('relative.txt');
    expect(await Bun.file(filePath).text()).toBe('after');
    await expect(
      executeEditFile(
        { path: filePath, oldString: 'after', newString: 'blocked' },
        makeContext({ deniedPaths: [tempDir] })
      )
    ).rejects.toThrow('in the denied paths');
  });
});

describe('edit_file argument handling', () => {
  it('preserves model replacement text verbatim', async () => {
    const filePath = await seedAndRead('verbatim.txt', 'before\n');

    await executeTool(
      'edit_file',
      { path: filePath, oldString: 'before', newString: 'after\nmore' },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('after\nmore\n');
  });

  it('rejects malformed replacement arguments before writing', async () => {
    const filePath = await seedAndRead('raw-invalid.txt', 'keep');

    await expect(
      executeTool('edit_file', { path: filePath, oldString: 42, newString: 'nope' }, makeContext())
    ).rejects.toThrow('Field "oldString" must be a string');
    await expect(
      executeTool(
        'edit_file',
        { path: filePath, oldString: 'keep', newString: 'nope', replaceAll: 'yes' },
        makeContext()
      )
    ).rejects.toThrow('Field "replaceAll" must be a boolean');
    expect(await Bun.file(filePath).text()).toBe('keep');
  });

  it('reads an explicit null replaceAll as absent', async () => {
    const filePath = await seedAndRead('raw-null-replace-all.txt', 'keep');

    await executeTool(
      'edit_file',
      { path: filePath, oldString: 'keep', newString: 'kept', replaceAll: null },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('kept');
  });

  it('rejects a relative path without a workdir', async () => {
    const relativePath = `edit-file-no-workdir-${crypto.randomUUID()}.txt`;

    await expect(
      executeTool(
        'edit_file',
        { path: relativePath, oldString: 'x', newString: 'y' },
        makeContext()
      )
    ).rejects.toThrow('no working directory is bound to this chat');
    expect(existsSync(join(process.cwd(), relativePath))).toBe(false);
  });
});
