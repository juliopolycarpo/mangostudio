import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathAccessError } from '../../../../src/services/tools/builtin/_fs-utils';
import {
  countTotalLines,
  executeReadFile,
  findWindowByteRange,
  looksBinary,
  normalizeReadFileToolSettings,
  READ_FILE_MAX_BINARY_VIEW_BYTES,
  READ_FILE_MAX_LINE_CHARS,
  READ_FILE_MAX_MAX_LINES,
  READ_FILE_MAX_START_LINE,
  READ_FILE_MAX_WINDOW_BYTES,
  READ_FILE_MIN_MAX_LINES,
  type ReadFileToolResult,
  register as registerReadFileTool,
} from '../../../../src/services/tools/builtin/read-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import { executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';
import { withTargetHome } from './support/target-home';
import { EMPTY_STRING_ARGUMENTS, useToolRegistry } from './support/tool-registry-harness';

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

async function sha256Of(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(filePath).bytes());
  return hasher.digest('hex');
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

  it('rejects binary files with a clear error that names the byte view', async () => {
    const filePath = join(tempDir, 'image.bin');
    await seedFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));

    const error = await executeReadFile({ path: filePath }, makeContext()).catch(
      (thrown: unknown) => thrown
    );

    expect((error as Error).message).toMatch(/appears to be a binary file/);
    // #619 stopped the model retrying an impossible remediation; naming the one
    // that works is what gives it a next move instead of only a dead end.
    expect((error as Error).message).toMatch(/view "hex" or "base64"/);
  });

  const BINARY_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
  for (const [view, expected] of [
    ['hex', '89504e47000d'],
    ['base64', Buffer.from(BINARY_BYTES).toString('base64')],
  ] as const) {
    it(`returns the raw bytes of a binary file as ${view}`, async () => {
      const filePath = join(tempDir, 'image.bin');
      await seedFile(filePath, BINARY_BYTES);

      const result = await executeReadFile({ path: filePath, view }, makeContext());

      expect(result.content).toBe(expected);
      expect(result.view).toBe(view);
      expect(result.size).toBe(BINARY_BYTES.byteLength);
      expect(result.sha256).toBe(await sha256Of(filePath));
      // A byte view has no line structure to report.
      expect(result.totalLines).toBe(0);
      expect(result.truncated).toBe(false);
    });
  }

  it('reads a text file through a byte view too, since a view is only an encoding', async () => {
    const filePath = join(tempDir, 'notes.md');
    await seedFile(filePath, 'hi\n');

    const result = await executeReadFile({ path: filePath, view: 'hex' }, makeContext());

    expect(result.content).toBe('68690a');
  });

  it('leaves a text read shaped exactly as it was before view existed', async () => {
    const filePath = join(tempDir, 'plain.txt');
    await seedFile(filePath, 'one\n');

    const explicit = await executeReadFile({ path: filePath, view: 'text' }, makeContext());

    expect(explicit.content).toBe(numbered(1, 'one'));
    expect(explicit.view).toBeUndefined();
  });

  it('refuses a byte view past its bound with the bound named', async () => {
    const filePath = join(tempDir, 'big.bin');
    const bytes = new Uint8Array(READ_FILE_MAX_BINARY_VIEW_BYTES + 1);
    bytes[0] = 0x00;
    await seedFile(filePath, bytes);

    const error = await executeReadFile({ path: filePath, view: 'hex' }, makeContext()).catch(
      (thrown: unknown) => thrown
    );

    expect((error as Error).message).toContain(String(READ_FILE_MAX_BINARY_VIEW_BYTES));
    expect((error as Error).message).toContain('not windowed');
  });

  it('accepts a binary file exactly at the byte-view bound', async () => {
    const filePath = join(tempDir, 'edge.bin');
    await seedFile(filePath, new Uint8Array(READ_FILE_MAX_BINARY_VIEW_BYTES));

    const result = await executeReadFile({ path: filePath, view: 'base64' }, makeContext());

    expect(result.size).toBe(READ_FILE_MAX_BINARY_VIEW_BYTES);
  });

  it('lets write_file overwrite a binary file once a byte view has read it', async () => {
    const filePath = join(tempDir, 'overwrite.bin');
    await seedFile(filePath, new Uint8Array([0x50, 0x4b, 0x00, 0x01]));

    // The whole point of the view: the freshness ledger is only populated by a
    // successful read, so before this the guard was unsatisfiable for a binary.
    await executeReadFile({ path: filePath, view: 'hex' }, makeContext());
    const written = await executeWriteFile(
      { path: filePath, content: 'text now\n' },
      makeContext()
    );

    expect(written.created).toBe(false);
    expect(await Bun.file(filePath).text()).toBe('text now\n');
  });

  it('still refuses an overwrite when the byte view was never read', async () => {
    const filePath = join(tempDir, 'unread.bin');
    await seedFile(filePath, new Uint8Array([0x50, 0x4b, 0x00, 0x01]));

    await expect(
      executeWriteFile({ path: filePath, content: 'text' }, makeContext())
    ).rejects.toThrow(/it is a binary file/);
  });

  it('does not offer the byte view for a binary file past its bound', async () => {
    const filePath = join(tempDir, 'huge.bin');
    await seedFile(filePath, new Uint8Array(READ_FILE_MAX_BINARY_VIEW_BYTES + 1));

    const error = await executeWriteFile({ path: filePath, content: 'text' }, makeContext()).catch(
      (thrown: unknown) => thrown
    );

    // Naming a remediation that would itself be refused is what #619 removed.
    expect((error as Error).message).toContain('byte-view limit');
    expect((error as Error).message).not.toContain('Read it with view');
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

  it('records whole-file sha256 on a windowed read so external edits stay detectable', async () => {
    const filePath = join(tempDir, 'fresh.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour');

    const read = await executeReadFile(
      { path: filePath, startLine: 2, maxLines: 1 },
      makeContext()
    );
    expect(read.endLine).toBe(2);
    expect(read.sha256).toBe(await sha256Of(filePath));
  });

  it('refuses to overwrite a file the model has only partially read', async () => {
    const filePath = join(tempDir, 'partial.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour');

    await executeReadFile({ path: filePath, startLine: 1, maxLines: 2 }, makeContext());

    await expect(
      executeWriteFile({ path: filePath, content: 'replaced\n' }, makeContext())
    ).rejects.toThrow(/only lines 1-2 have been read/);
    expect(await Bun.file(filePath).text()).toBe('one\ntwo\nthree\nfour');
  });

  it('allows the overwrite once sequential windows have covered the whole file', async () => {
    const filePath = join(tempDir, 'paged.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour');

    await executeReadFile({ path: filePath, startLine: 1, maxLines: 2 }, makeContext());
    await executeReadFile({ path: filePath, startLine: 3, maxLines: 2 }, makeContext());

    const written = await executeWriteFile(
      { path: filePath, content: 'replaced\n' },
      makeContext()
    );
    expect(written.created).toBe(false);
    expect(await Bun.file(filePath).text()).toBe('replaced\n');
  });

  it('does not let a window that skips earlier lines count as coverage', async () => {
    const filePath = join(tempDir, 'gap.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour');

    await executeReadFile({ path: filePath, startLine: 3, maxLines: 2 }, makeContext());

    await expect(
      executeWriteFile({ path: filePath, content: 'replaced\n' }, makeContext())
    ).rejects.toThrow(/it has not been read from line 1/);
  });

  it('treats a read that reaches the last line as full coverage', async () => {
    const filePath = join(tempDir, 'whole.txt');
    await seedFile(filePath, 'one\ntwo\nthree\nfour');

    await executeReadFile({ path: filePath }, makeContext());

    const written = await executeWriteFile(
      { path: filePath, content: 'replaced\n' },
      makeContext()
    );
    expect(written.created).toBe(false);
  });

  it('keeps a written file writable when a later read only windows it', async () => {
    const filePath = join(tempDir, 'write-then-window.txt');
    await executeWriteFile({ path: filePath, content: 'one\ntwo\nthree\n' }, makeContext());

    await executeReadFile({ path: filePath, startLine: 2, maxLines: 1 }, makeContext());

    const written = await executeWriteFile({ path: filePath, content: 'again\n' }, makeContext());
    expect(written.created).toBe(false);
    expect(await Bun.file(filePath).text()).toBe('again\n');
  });

  it('explains that a binary file cannot be overwritten instead of demanding a read', async () => {
    const filePath = join(tempDir, 'blob.bin');
    await seedFile(filePath, new Uint8Array([0x50, 0x4b, 0x00, 0x01]));

    await expect(executeReadFile({ path: filePath }, makeContext())).rejects.toThrow(
      /appears to be a binary file/
    );
    await expect(
      executeWriteFile({ path: filePath, content: 'text' }, makeContext())
    ).rejects.toThrow(/it is a binary file/);
  });

  it('expands ~ to the home directory the runtime reports', async () => {
    const filePath = join(tempDir, 'home-test.txt');
    await seedFile(filePath, 'home content');

    const result = await withTargetHome(tempDir, () =>
      executeReadFile({ path: '~/home-test.txt' }, makeContext())
    );
    expect(result.content).toBe(numbered(1, 'home content'));
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

describe('read_file registry contract', () => {
  const harness = useToolRegistry('read-file-registry', registerReadFileTool);

  async function seedLines(count: number, name = 'lines.txt'): Promise<string> {
    const filePath = harness.path(name);
    await seedFile(
      filePath,
      Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
    );
    return filePath;
  }

  function read(args: Record<string, unknown>): Promise<ReadFileToolResult> {
    return executeTool('read_file', args, harness.context()) as Promise<ReadFileToolResult>;
  }

  it('rejects a missing path', async () => {
    await expect(read({})).rejects.toThrow('Missing required path.');
  });

  for (const [label, value] of EMPTY_STRING_ARGUMENTS) {
    it(`rejects ${label} path with the missing-path error, not a TypeError`, async () => {
      const error = await read({ path: value }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PathAccessError);
      expect((error as Error).message).toBe('Missing required path.');
    });
  }

  it('reads the whole file when startLine and maxLines are absent', async () => {
    const filePath = await seedLines(3);

    const result = await read({ path: filePath });

    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('windows the file with valid startLine and maxLines', async () => {
    const filePath = await seedLines(10);

    const result = await read({ path: filePath, startLine: 4, maxLines: 2 });

    expect(result.startLine).toBe(4);
    expect(result.endLine).toBe(5);
    expect(result.content).toContain(numbered(4, 'line 4'));
    expect(result.content).not.toContain(numbered(6, 'line 6'));
  });

  it('trims the path argument before resolving it', async () => {
    const filePath = await seedLines(1);

    const result = await read({ path: `  ${filePath}  ` });

    expect(result.totalLines).toBe(1);
  });

  it('clamps startLine up to the lower bound instead of reading line zero', async () => {
    const filePath = await seedLines(3);

    const result = await read({ path: filePath, startLine: 0 });

    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
  });

  it('clamps startLine down to the upper bound', async () => {
    const filePath = await seedLines(3);

    // The clamped value surfaces in the past-the-end message, which is how the
    // upper bound stays observable without a ten-million-line fixture.
    await expect(read({ path: filePath, startLine: 5e9 })).rejects.toThrow(
      `startLine ${READ_FILE_MAX_START_LINE} is past the end`
    );
  });

  it('rejects a fractional startLine rather than rounding to a line nobody asked for', async () => {
    const filePath = await seedLines(5);

    await expect(read({ path: filePath, startLine: 2.6 })).rejects.toThrow(
      'Field "startLine" must be an integer.'
    );
  });

  it('reads an explicit null startLine and maxLines as absent', async () => {
    const filePath = await seedLines(3);

    const result = await read({ path: filePath, startLine: null, maxLines: null });

    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
  });

  it('clamps maxLines up to the lower bound', async () => {
    const filePath = await seedLines(4);

    const result = await read({ path: filePath, maxLines: 0 });

    expect(result.endLine).toBe(READ_FILE_MIN_MAX_LINES);
    expect(result.truncated).toBe(true);
  });

  it('clamps maxLines down to the upper bound', async () => {
    const filePath = await seedLines(READ_FILE_MAX_MAX_LINES + 1, 'many-lines.txt');

    const result = await read({ path: filePath, maxLines: 10 * READ_FILE_MAX_MAX_LINES });

    expect(result.endLine).toBe(READ_FILE_MAX_MAX_LINES);
    expect(result.truncated).toBe(true);
  });

  for (const [label, args] of [
    ['a non-numeric startLine', { startLine: '2' }],
    ['a NaN startLine', { startLine: Number.NaN }],
    ['a fractional maxLines', { maxLines: 10.5 }],
    ['a non-numeric maxLines', { maxLines: '10' }],
    ['an infinite maxLines', { maxLines: Number.POSITIVE_INFINITY }],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const filePath = await seedLines(2);
      const field = 'startLine' in args ? 'startLine' : 'maxLines';

      await expect(read({ path: filePath, ...args })).rejects.toThrow(
        `Field "${field}" must be an integer.`
      );
    });
  }

  it('reads an explicit null view as text', async () => {
    const filePath = await seedLines(2);

    const result = await read({ path: filePath, view: null });

    expect(result.view).toBeUndefined();
    expect(result.totalLines).toBe(2);
  });

  for (const [label, value] of [
    ['an unknown name', 'utf16'],
    ['a mis-cased name', 'HEX'],
  ] as const) {
    it(`rejects ${label} for view instead of falling back to text`, async () => {
      const filePath = await seedLines(2);

      await expect(read({ path: filePath, view: value })).rejects.toThrow(
        'Field "view" must be one of "text", "hex", "base64".'
      );
    });
  }

  it('rejects a non-string view', async () => {
    const filePath = await seedLines(2);

    await expect(read({ path: filePath, view: 2 })).rejects.toThrow(
      'Field "view" must be a string.'
    );
  });

  for (const field of ['startLine', 'maxLines'] as const) {
    it(`rejects ${field} alongside a byte view rather than dropping the window`, async () => {
      const filePath = await seedLines(5);

      // Silently returning the whole file reads to the model as the slice it
      // asked for — the failure mode strict argument handling exists to remove.
      await expect(read({ path: filePath, view: 'hex', [field]: 2 })).rejects.toThrow(
        'apply to view "text" only'
      );
    });
  }

  it('accepts a byte view with the line arguments explicitly null', async () => {
    const filePath = await seedLines(2);

    const result = await read({ path: filePath, view: 'hex', startLine: null, maxLines: null });

    expect(result.view).toBe('hex');
  });
});
