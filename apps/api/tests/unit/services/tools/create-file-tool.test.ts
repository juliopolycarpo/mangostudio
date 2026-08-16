import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeCreateFile,
  normalizeCreateFileToolSettings,
  register as registerCreateFileTool,
} from '../../../../src/services/tools/builtin/create-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import { clearRegistry, executeTool, getTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  clearRegistry();
  registerCreateFileTool();
  tempDir = mkdtempSync(join(tmpdir(), 'create-file-test-'));
});

afterEach(() => {
  clearFileFreshness();
  clearRegistry();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

describe('normalizeCreateFileToolSettings', () => {
  it('normalizes current and legacy path lists', () => {
    expect(normalizeCreateFileToolSettings({})).toEqual({
      allowedPaths: [],
      deniedPaths: [],
    });
    expect(
      normalizeCreateFileToolSettings({
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

describe('executeCreateFile', () => {
  it('creates a new file and missing parents, returning its digest', async () => {
    const filePath = join(tempDir, 'nested', 'hello.txt');

    const result = await executeCreateFile(
      { path: filePath, content: 'Hello, world!' },
      makeContext()
    );

    expect(result).toEqual({
      path: filePath,
      bytesWritten: 13,
      sha256: '315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3',
    });
    expect(await Bun.file(filePath).text()).toBe('Hello, world!');
  });

  it('anchors relative paths to the chat workdir', async () => {
    const result = await executeCreateFile(
      { path: 'src/index.ts', content: 'export {};' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result.path).toBe('src/index.ts');
    expect(await Bun.file(join(tempDir, 'src', 'index.ts')).text()).toBe('export {};');
  });

  it('rejects a relative path without a chat workdir', async () => {
    const relativePath = `create-file-no-workdir-${crypto.randomUUID()}/file.txt`;

    await expect(
      executeCreateFile({ path: relativePath, content: 'nope' }, makeContext())
    ).rejects.toThrow('no working directory is bound to this chat');
    expect(existsSync(join(process.cwd(), relativePath))).toBe(false);
  });

  it('never overwrites an existing file', async () => {
    const filePath = join(tempDir, 'existing.txt');
    await Bun.write(filePath, 'keep me');

    await expect(
      executeCreateFile({ path: filePath, content: 'replacement' }, makeContext())
    ).rejects.toThrow(
      `"${filePath}" already exists. Read it with read_file, then use edit_file for an exact text change, replace_range for a line change, or write_file to replace all content.`
    );
    expect(await Bun.file(filePath).text()).toBe('keep me');
  });

  it('points at the available tools when the destination is taken', async () => {
    const filePath = join(tempDir, 'taken.txt');
    await Bun.write(filePath, 'keep me');

    const error = (await executeCreateFile(
      { path: filePath, content: 'replacement' },
      makeContext()
    ).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).toContain('edit_file');
    expect(error.message).toContain('replace_range');
    expect(getTool('create_file')?.definition.description).toContain('edit_file');
    expect(getTool('create_file')?.definition.description).toContain('replace_range');
  });

  it('names the real blocker when a parent component is a regular file', async () => {
    const parent = join(tempDir, 'not-a-directory');
    await Bun.write(parent, 'x');
    const filePath = join(parent, 'child.txt');

    await expect(
      executeCreateFile({ path: filePath, content: 'nope' }, makeContext())
    ).rejects.toThrow(`Cannot create "${filePath}": "${parent}" is not a directory.`);
  });

  it('reports a non-regular destination instead of claiming it can be overwritten', async () => {
    const directory = join(tempDir, 'directory');
    mkdirSync(directory);

    await expect(
      executeCreateFile({ path: directory, content: 'nope' }, makeContext())
    ).rejects.toThrow('is not a regular file');
  });

  it('allows an immediate guarded write because creation records freshness', async () => {
    const filePath = join(tempDir, 'fresh.txt');
    await executeCreateFile({ path: filePath, content: 'first' }, makeContext());

    const written = await executeWriteFile({ path: filePath, content: 'second' }, makeContext());

    expect(written.created).toBe(false);
    expect(await Bun.file(filePath).text()).toBe('second');
  });

  it('enforces allowed and denied path settings', async () => {
    const filePath = join(tempDir, 'blocked.txt');

    await expect(
      executeCreateFile(
        { path: filePath, content: 'nope' },
        makeContext({ allowedPaths: ['/somewhere-else'] })
      )
    ).rejects.toThrow('not in the allowed paths');
    await expect(
      executeCreateFile(
        { path: filePath, content: 'nope' },
        makeContext({ deniedPaths: [tempDir] })
      )
    ).rejects.toThrow('in the denied paths');
    expect(existsSync(filePath)).toBe(false);
  });

  it('enforces restricted workdir containment', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'create-file-outside-'));
    try {
      const outsidePath = join(outsideDir, 'outside.txt');
      await expect(
        executeCreateFile(
          { path: outsidePath, content: 'nope' },
          {
            ...makeContext(),
            workdir: tempDir,
            workdirPolicy: { root: tempDir, restricted: true },
          }
        )
      ).rejects.toThrow('outside the chat working directory');
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('serializes parallel creates so exactly one caller succeeds', async () => {
    const filePath = join(tempDir, 'parallel.txt');

    const results = await Promise.allSettled([
      executeCreateFile({ path: filePath, content: 'first' }, makeContext()),
      executeCreateFile({ path: filePath, content: 'second' }, makeContext()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    // The lock is exclusive, not FIFO: whichever caller is scheduled first
    // wins, and the other is the existing-file rejection.
    expect(['first', 'second']).toContain(await Bun.file(filePath).text());
  });
});

describe('create_file argument handling', () => {
  it('writes model content verbatim, keeping the trailing newline', async () => {
    const filePath = join(tempDir, 'verbatim.md');
    const content = '# Title\n\nbody\n';

    const result = (await executeTool(
      'create_file',
      { path: filePath, content },
      makeContext()
    )) as { bytesWritten: number };

    expect(result.bytesWritten).toBe(Buffer.byteLength(content));
    expect(await Bun.file(filePath).text()).toBe(content);
  });

  it('creates an empty file when content is empty', async () => {
    const filePath = join(tempDir, 'empty.txt');

    const result = (await executeTool(
      'create_file',
      { path: filePath, content: '' },
      makeContext()
    )) as {
      bytesWritten: number;
    };

    expect(result.bytesWritten).toBe(0);
    expect(await Bun.file(filePath).text()).toBe('');
  });

  it('still rejects a non-string content argument', async () => {
    const filePath = join(tempDir, 'invalid.txt');

    await expect(
      executeTool('create_file', { path: filePath, content: 42 }, makeContext())
    ).rejects.toThrow('Field "content" must be a string');
    expect(existsSync(filePath)).toBe(false);
  });
});
