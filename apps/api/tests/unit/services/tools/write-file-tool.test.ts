import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathAccessError } from '../../../../src/services/tools/builtin/_fs-utils';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import {
  executeWriteFile,
  normalizeWriteFileToolSettings,
  register as registerWriteFileTool,
  type WriteFileToolResult,
} from '../../../../src/services/tools/builtin/write-file';
import {
  clearFileFreshness,
  FileNotReadError,
  StaleFileError,
} from '../../../../src/services/tools/file-freshness';
import { executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';
import { withTargetHome } from './support/target-home';
import {
  EMPTY_STRING_ARGUMENTS,
  NON_STRING_ARGUMENTS,
  useToolRegistry,
} from './support/tool-registry-harness';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'write-file-test-'));
});

afterEach(() => {
  clearFileFreshness();
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
    await executeReadFile({ path: filePath }, makeContext());

    const result = await executeWriteFile(
      { path: filePath, content: 'new content' },
      makeContext()
    );

    expect(result.path).toBe(filePath);
    expect(result.created).toBe(false);
    expect(result.bytesWritten).toBe(11);
    expect(result.sha256).toBe('fe32608c9ef5b6cf7e3f946480253ff76f24f4ec0678f3d0f07f9844cbff9601');
    expect(await readBack(filePath)).toBe('new content');
  });

  it('rejects overwriting a file that the chat has not read', async () => {
    const filePath = join(tempDir, 'unread.txt');
    await seedFile(filePath, 'keep me');

    await expect(
      executeWriteFile({ path: filePath, content: 'replacement' }, makeContext())
    ).rejects.toBeInstanceOf(FileNotReadError);
    expect(await readBack(filePath)).toBe('keep me');
  });

  it('rejects overwriting a file changed after the chat read it', async () => {
    const filePath = join(tempDir, 'stale.txt');
    await seedFile(filePath, 'observed');
    await executeReadFile({ path: filePath }, makeContext());
    await seedFile(filePath, 'changed outside the tool');

    await expect(
      executeWriteFile({ path: filePath, content: 'replacement' }, makeContext())
    ).rejects.toBeInstanceOf(StaleFileError);
    expect(await readBack(filePath)).toBe('changed outside the tool');
  });

  it('allows sequential writes after one read because each write refreshes the snapshot', async () => {
    const filePath = join(tempDir, 'sequential.txt');
    await seedFile(filePath, 'initial');
    await executeReadFile({ path: filePath }, makeContext());

    await executeWriteFile({ path: filePath, content: 'first' }, makeContext());
    await executeWriteFile({ path: filePath, content: 'second' }, makeContext());

    expect(await readBack(filePath)).toBe('second');
  });

  it('serializes parallel writes to one path in call order', async () => {
    const filePath = join(tempDir, 'parallel.txt');
    await seedFile(filePath, 'initial');
    await executeReadFile({ path: filePath }, makeContext());

    await Promise.all([
      executeWriteFile({ path: filePath, content: 'first' }, makeContext()),
      executeWriteFile({ path: filePath, content: 'second' }, makeContext()),
    ]);

    expect(await readBack(filePath)).toBe('second');
  });

  it("does not let another chat use the first chat's read", async () => {
    const filePath = join(tempDir, 'chat-bound.txt');
    await seedFile(filePath, 'initial');
    await executeReadFile({ path: filePath }, makeContext());

    await expect(
      executeWriteFile(
        { path: filePath, content: 'other chat' },
        { ...makeContext(), chatId: 'c2' }
      )
    ).rejects.toBeInstanceOf(FileNotReadError);
    expect(await readBack(filePath)).toBe('initial');
  });

  it('preserves the existing file mode across an atomic overwrite', async () => {
    if (process.platform === 'win32') return;

    const filePath = join(tempDir, 'mode.txt');
    await seedFile(filePath, 'initial');
    chmodSync(filePath, 0o640);
    await executeReadFile({ path: filePath }, makeContext());

    await executeWriteFile({ path: filePath, content: 'replacement' }, makeContext());

    expect(statSync(filePath).mode & 0o777).toBe(0o640);
  });

  it('commits through a same-directory temp file without leaving artifacts', async () => {
    const filePath = join(tempDir, 'atomic.txt');

    await executeWriteFile({ path: filePath, content: 'complete content' }, makeContext());

    expect(await readBack(filePath)).toBe('complete content');
    expect(readdirSync(tempDir)).toEqual(['atomic.txt']);
  });

  it('refuses to replace a symlink and leaves its target untouched', async () => {
    if (process.platform === 'win32') return;

    const targetPath = join(tempDir, 'target.txt');
    const linkPath = join(tempDir, 'link.txt');
    await seedFile(targetPath, 'original');
    symlinkSync(targetPath, linkPath);
    await executeReadFile({ path: linkPath }, makeContext());

    const error = await executeWriteFile(
      { path: linkPath, content: 'via link' },
      makeContext()
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PathAccessError);
    expect((error as Error).message).toContain('symbolic link');
    expect((error as Error).message).toContain(targetPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(await readBack(targetPath)).toBe('original');
  });

  it('refuses to overwrite a read-only file', async () => {
    // root bypasses the file's own write permission, so the guard cannot fire.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const filePath = join(tempDir, 'readonly.txt');
    await seedFile(filePath, 'protected');
    await executeReadFile({ path: filePath }, makeContext());
    chmodSync(filePath, 0o444);

    try {
      const error = await executeWriteFile(
        { path: filePath, content: 'replacement' },
        makeContext()
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PathAccessError);
      expect((error as Error).message).toContain('not writable');
      expect(await readBack(filePath)).toBe('protected');
    } finally {
      chmodSync(filePath, 0o600);
    }
  });

  it('reports a directory destination instead of demanding an impossible read', async () => {
    const dirPath = join(tempDir, 'a-directory');
    mkdirSync(dirPath);

    const error = await executeWriteFile(
      { path: dirPath, content: 'content' },
      makeContext()
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PathAccessError);
    expect((error as Error).message).toContain('not a regular file');
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

  it('expands ~ to the home directory the runtime reports', async () => {
    const result = await withTargetHome(tempDir, () =>
      executeWriteFile({ path: '~/home-write.txt', content: 'home content' }, makeContext())
    );
    expect(result.created).toBe(true);
    expect(await readBack(join(tempDir, 'home-write.txt'))).toBe('home content');
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

describe('write_file registry contract', () => {
  const harness = useToolRegistry('write-file-registry', registerWriteFileTool);

  function write(args: Record<string, unknown>): Promise<WriteFileToolResult> {
    return executeTool('write_file', args, harness.context()) as Promise<WriteFileToolResult>;
  }

  it('rejects a missing path', async () => {
    await expect(write({ content: 'body' })).rejects.toThrow('Missing required path.');
  });

  it('rejects a missing content', async () => {
    await expect(write({ path: harness.path('no-content.txt') })).rejects.toThrow(
      'Missing required field "content".'
    );
  });

  for (const [label, value] of EMPTY_STRING_ARGUMENTS) {
    it(`rejects ${label} path with the missing-path error, not a TypeError`, async () => {
      const error = await write({ path: value, content: 'body' }).catch(
        (thrown: unknown) => thrown
      );

      expect(error).toBeInstanceOf(PathAccessError);
      expect((error as Error).message).toBe('Missing required path.');
    });
  }

  for (const [label, value] of NON_STRING_ARGUMENTS) {
    it(`rejects ${label} content`, async () => {
      const filePath = harness.path('invalid-content.txt');

      await expect(write({ path: filePath, content: value })).rejects.toThrow(
        'Field "content" must be a string.'
      );
      expect(existsSync(filePath)).toBe(false);
    });
  }

  it('writes an empty file when content is an empty string', async () => {
    const filePath = harness.path('empty.txt');

    const result = await write({ path: filePath, content: '' });

    expect(result.bytesWritten).toBe(0);
    expect(result.created).toBe(true);
    expect(await readBack(filePath)).toBe('');
  });

  it('preserves every trailing newline in the payload', async () => {
    const filePath = harness.path('trailing.txt');
    const content = 'a\n\n';

    const result = await write({ path: filePath, content });

    expect(result.bytesWritten).toBe(Buffer.byteLength(content));
    expect(await readBack(filePath)).toBe(content);
  });

  it('writes whitespace-only content verbatim', async () => {
    const filePath = harness.path('whitespace.txt');

    await write({ path: filePath, content: '  \n\t' });

    expect(await readBack(filePath)).toBe('  \n\t');
  });

  it('trims the path but not the content, because only one of them is an identifier', async () => {
    const filePath = harness.path('asymmetric.txt');

    await write({ path: `  ${filePath}  `, content: '  body  ' });

    expect(await readBack(filePath)).toBe('  body  ');
  });

  it('resolves a relative path against the chat workdir', async () => {
    const result = await write({ path: 'nested/relative.txt', content: 'body' });

    expect(result.path).toBe('nested/relative.txt');
    expect(await readBack(harness.path('nested', 'relative.txt'))).toBe('body');
  });
});
