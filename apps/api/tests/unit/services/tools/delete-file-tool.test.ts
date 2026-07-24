import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathAccessError } from '../../../../src/services/tools/builtin/_fs-utils';
import {
  type DeleteFileToolResult,
  executeDeleteFile,
  normalizeDeleteFileToolSettings,
  register as registerDeleteFileTool,
} from '../../../../src/services/tools/builtin/delete-file';
import {
  executeReadFile,
  register as registerReadFile,
} from '../../../../src/services/tools/builtin/read-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import {
  clearFileFreshness,
  FileNotReadError,
  StaleFileError,
} from '../../../../src/services/tools/file-freshness';
import { executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';
import { EMPTY_STRING_ARGUMENTS, useToolRegistry } from './support/tool-registry-harness';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'delete-file-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

describe('normalizeDeleteFileToolSettings', () => {
  it('normalizes current and legacy path lists', () => {
    expect(normalizeDeleteFileToolSettings({})).toEqual({
      allowedPaths: [],
      deniedPaths: [],
    });
    expect(
      normalizeDeleteFileToolSettings({
        allowedPaths: ['/home'],
        deniedPaths: [{ path: '/etc', enabled: true }],
      })
    ).toEqual({
      allowedPaths: [{ path: '/home', enabled: true }],
      deniedPaths: [{ path: '/etc', enabled: true }],
    });
  });
});

describe('executeDeleteFile', () => {
  it('deletes a freshly read regular file', async () => {
    const filePath = join(tempDir, 'delete-me.txt');
    await Bun.write(filePath, 'observed');
    await executeReadFile({ path: filePath }, makeContext());

    const result = await executeDeleteFile({ path: filePath }, makeContext());

    expect(result).toEqual({ path: filePath, deleted: true });
    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects deleting a file the chat has not read', async () => {
    const filePath = join(tempDir, 'unread.txt');
    await Bun.write(filePath, 'keep me');

    await expect(executeDeleteFile({ path: filePath }, makeContext())).rejects.toBeInstanceOf(
      FileNotReadError
    );
    expect(await Bun.file(filePath).text()).toBe('keep me');
  });

  it('rejects deleting a partially read file', async () => {
    const filePath = join(tempDir, 'partial.txt');
    await Bun.write(filePath, 'one\ntwo\nthree');
    await executeReadFile({ path: filePath, maxLines: 1 }, makeContext());

    await expect(executeDeleteFile({ path: filePath }, makeContext())).rejects.toThrow(
      'only lines 1-1 have been read'
    );
    expect(await Bun.file(filePath).text()).toBe('one\ntwo\nthree');
  });

  it('rejects deleting a file changed after the read', async () => {
    const filePath = join(tempDir, 'stale.txt');
    await Bun.write(filePath, 'observed');
    await executeReadFile({ path: filePath }, makeContext());
    await Bun.write(filePath, 'changed elsewhere');

    await expect(executeDeleteFile({ path: filePath }, makeContext())).rejects.toBeInstanceOf(
      StaleFileError
    );
    expect(await Bun.file(filePath).text()).toBe('changed elsewhere');
  });

  it('forgets freshness after deletion', async () => {
    const filePath = join(tempDir, 'forgotten.txt');
    await Bun.write(filePath, 'observed');
    await executeReadFile({ path: filePath }, makeContext());
    await executeDeleteFile({ path: filePath }, makeContext());
    await Bun.write(filePath, 'replacement from elsewhere');

    await expect(
      executeWriteFile({ path: filePath, content: 'must not overwrite' }, makeContext())
    ).rejects.toBeInstanceOf(FileNotReadError);
    expect(await Bun.file(filePath).text()).toBe('replacement from elsewhere');
  });

  it('names the binary blocker instead of demanding an impossible read', async () => {
    const filePath = join(tempDir, 'blob.bin');
    await Bun.write(filePath, new Uint8Array([0x01, 0x00, 0x02]));

    // read_file refuses binary files, so "read it first" would loop forever.
    await expect(executeReadFile({ path: filePath }, makeContext())).rejects.toThrow('binary file');
    const error = (await executeDeleteFile({ path: filePath }, makeContext()).catch(
      (thrown: unknown) => thrown
    )) as Error;

    expect(error).not.toBeInstanceOf(FileNotReadError);
    expect(error.message).toContain('read-before-delete guard cannot be satisfied');
    expect(existsSync(filePath)).toBe(true);
  });

  it('explains a partial read in terms of deletion, not overwriting', async () => {
    const filePath = join(tempDir, 'partial-wording.txt');
    await Bun.write(filePath, 'one\ntwo\nthree');
    await executeReadFile({ path: filePath, maxLines: 1 }, makeContext());

    const error = (await executeDeleteFile({ path: filePath }, makeContext()).catch(
      (thrown: unknown) => thrown
    )) as Error;

    expect(error.message).not.toContain('Cannot overwrite');
    expect(error.message).not.toContain('write_file replaces');
  });

  it('reports missing files without suggesting an impossible read', async () => {
    const filePath = join(tempDir, 'missing.txt');

    await expect(executeDeleteFile({ path: filePath }, makeContext())).rejects.toThrow(
      `File not found: "${filePath}"`
    );
  });

  it('never deletes directories', async () => {
    const directory = join(tempDir, 'directory');
    mkdirSync(directory);

    await expect(executeDeleteFile({ path: directory }, makeContext())).rejects.toThrow(
      'it is not a regular file'
    );
    expect(existsSync(directory)).toBe(true);
  });

  it('never follows and deletes symbolic links', async () => {
    if (process.platform === 'win32') return;
    const target = join(tempDir, 'target.txt');
    const link = join(tempDir, 'link.txt');
    await Bun.write(target, 'keep me');
    symlinkSync(target, link);
    await executeReadFile({ path: link }, makeContext());

    await expect(executeDeleteFile({ path: link }, makeContext())).rejects.toThrow(
      'symbolic links are not supported'
    );
    expect(existsSync(link)).toBe(true);
    expect(await Bun.file(target).text()).toBe('keep me');
  });

  it('enforces allowed and denied path settings before deleting', async () => {
    const filePath = join(tempDir, 'blocked.txt');
    await Bun.write(filePath, 'keep me');
    await executeReadFile({ path: filePath }, makeContext());

    await expect(
      executeDeleteFile({ path: filePath }, makeContext({ allowedPaths: ['/somewhere-else'] }))
    ).rejects.toThrow('not in the allowed paths');
    await expect(
      executeDeleteFile({ path: filePath }, makeContext({ deniedPaths: [tempDir] }))
    ).rejects.toThrow('in the denied paths');
    expect(await Bun.file(filePath).text()).toBe('keep me');
  });

  it('enforces restricted workdir containment', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'delete-file-outside-'));
    try {
      const outsidePath = join(outsideDir, 'outside.txt');
      await Bun.write(outsidePath, 'keep me');
      await executeReadFile({ path: outsidePath }, makeContext());

      await expect(
        executeDeleteFile(
          { path: outsidePath },
          {
            ...makeContext(),
            workdir: tempDir,
            workdirPolicy: { root: tempDir, restricted: true },
          }
        )
      ).rejects.toThrow('outside the chat working directory');
      expect(await Bun.file(outsidePath).text()).toBe('keep me');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('delete_file registry contract', () => {
  const harness = useToolRegistry('delete-file-registry', registerDeleteFileTool, registerReadFile);

  function remove(args: Record<string, unknown>): Promise<DeleteFileToolResult> {
    return executeTool('delete_file', args, harness.context()) as Promise<DeleteFileToolResult>;
  }

  it('rejects a missing path', async () => {
    await expect(remove({})).rejects.toThrow('Missing required path.');
  });

  for (const [label, value] of EMPTY_STRING_ARGUMENTS) {
    it(`rejects ${label} path with the missing-path error, not a TypeError`, async () => {
      const error = await remove({ path: value }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PathAccessError);
      expect((error as Error).message).toBe('Missing required path.');
    });
  }

  it('deletes a file that was read through the registry', async () => {
    const filePath = harness.path('delete-me.txt');
    await Bun.write(filePath, 'observed');
    await executeTool('read_file', { path: filePath }, harness.context());

    const result = await remove({ path: filePath });

    expect(result).toEqual({ path: filePath, deleted: true });
    expect(existsSync(filePath)).toBe(false);
  });

  it('trims a padded path before resolving it', async () => {
    const filePath = harness.path('padded.txt');
    await Bun.write(filePath, 'observed');
    await executeTool('read_file', { path: `  ${filePath}  ` }, harness.context());

    await remove({ path: `  ${filePath}  ` });

    expect(existsSync(filePath)).toBe(false);
  });

  it('still refuses to delete a file the chat never read', async () => {
    const filePath = harness.path('unread.txt');
    await Bun.write(filePath, 'keep me');

    await expect(remove({ path: filePath })).rejects.toBeInstanceOf(FileNotReadError);
    expect(await Bun.file(filePath).text()).toBe('keep me');
  });
});
