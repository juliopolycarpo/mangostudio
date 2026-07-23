import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeApplyPatch,
  normalizeApplyPatchToolSettings,
  register as registerApplyPatchTool,
} from '../../../../src/services/tools/builtin/apply-patch';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import { executeReplaceRange } from '../../../../src/services/tools/builtin/replace-range';
import {
  assertFresh,
  clearFileFreshness,
  FileNotReadError,
  StaleFileError,
  StaleLineNumbersError,
} from '../../../../src/services/tools/file-freshness';
import { clearRegistry, executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  clearRegistry();
  registerApplyPatchTool();
  tempDir = mkdtempSync(join(tmpdir(), 'apply-patch-test-'));
});

afterEach(() => {
  clearFileFreshness();
  clearRegistry();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', workdir: tempDir, parameters };
}

async function seedAndRead(relativePath: string, content: string): Promise<string> {
  const filePath = join(tempDir, relativePath);
  await Bun.write(filePath, content);
  await executeReadFile({ path: filePath, maxLines: 5000 }, makeContext());
  return filePath;
}

describe('normalizeApplyPatchToolSettings', () => {
  it('normalizes current and legacy path lists', () => {
    expect(
      normalizeApplyPatchToolSettings({
        allowedPaths: [{ path: tempDir, enabled: true }],
        deniedPaths: '/etc\n/root',
      })
    ).toEqual({
      allowedPaths: [{ path: tempDir, enabled: true }],
      deniedPaths: [
        { path: '/etc', enabled: true },
        { path: '/root', enabled: true },
      ],
    });
  });
});

describe('executeApplyPatch', () => {
  it('applies add, multi-hunk update, and delete operations together', async () => {
    const updatedPath = await seedAndRead(
      'src/existing.ts',
      'function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n'
    );
    const deletedPath = await seedAndRead('src/dead.ts', 'remove me\n');

    const result = await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Add File: src/new.ts
+export const added = true;
*** Update File: src/existing.ts
@@ function one() {
-  return 1;
+  return 10;
@@ function two() {
-  return 2;
+  return 20;
*** Delete File: src/dead.ts
*** End Patch`,
      },
      makeContext()
    );

    expect(await Bun.file(join(tempDir, 'src/new.ts')).text()).toBe('export const added = true;\n');
    expect(await Bun.file(updatedPath).text()).toBe(
      'function one() {\n  return 10;\n}\n\nfunction two() {\n  return 20;\n}\n'
    );
    expect(existsSync(deletedPath)).toBe(false);
    expect(result.summary).toBe('3 files changed');
    expect(result.files.map((file) => file.op)).toEqual(['add', 'update', 'delete']);
    expect(result.files[0]?.sha256).toHaveLength(64);
    expect(result.files[1]?.sha256).toHaveLength(64);
  });

  it('stales the line numbering an update shifted for later line-addressed edits', async () => {
    const filePath = await seedAndRead('lines.txt', 'a\nb\nc\nd\n');

    await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Update File: lines.txt
 a
-b
 c
*** End Patch`,
      },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('a\nc\nd\n');
    // The patch deleted line 2, so the model's pre-patch numbers past line 1 no
    // longer address the intended lines; replace_range must force a re-read.
    await expect(
      executeReplaceRange(
        { path: filePath, startLine: 3, endLine: 3, content: 'D\n' },
        makeContext()
      )
    ).rejects.toBeInstanceOf(StaleLineNumbersError);
    expect(await Bun.file(filePath).text()).toBe('a\nc\nd\n');
  });

  it('creates missing parent directories and empty files', async () => {
    const result = await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Add File: nested/deep/empty.txt
*** End Patch`,
      },
      makeContext()
    );

    expect(await Bun.file(join(tempDir, 'nested/deep/empty.txt')).text()).toBe('');
    expect(result).toMatchObject({
      summary: '1 file changed',
      files: [{ path: 'nested/deep/empty.txt', op: 'add' }],
    });
  });

  it('updates and moves a file without overwriting the destination', async () => {
    const sourcePath = await seedAndRead('old.txt', 'before\n');

    const result = await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Update File: old.txt
*** Move to: moved/new.txt
-before
+after
*** End Patch`,
      },
      makeContext()
    );

    const movedPath = join(tempDir, 'moved/new.txt');
    expect(existsSync(sourcePath)).toBe(false);
    expect(await Bun.file(movedPath).text()).toBe('after\n');
    expect(result.files[0]).toMatchObject({
      path: 'old.txt',
      op: 'move',
      movedTo: 'moved/new.txt',
    });
    await expect(assertFresh('c1', movedPath)).resolves.toBeUndefined();
  });

  it('supports a move-only update without rewriting content', async () => {
    const sourcePath = await seedAndRead('old.txt', 'unchanged\n');

    await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
*** End Patch`,
      },
      makeContext()
    );

    expect(existsSync(sourcePath)).toBe(false);
    expect(await Bun.file(join(tempDir, 'new.txt')).text()).toBe('unchanged\n');
  });

  it('falls back to matching context without trailing whitespace', async () => {
    const filePath = await seedAndRead('spaces.ts', 'const value = 1;   \n');

    await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Update File: spaces.ts
-const value = 1;
+const value = 2;
*** End Patch`,
      },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe('const value = 2;\n');
  });

  it('uses context markers to disambiguate repeated text', async () => {
    const filePath = await seedAndRead(
      'markers.ts',
      'function first() {\n  return false;\n}\nfunction second() {\n  return false;\n}\n'
    );

    await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Update File: markers.ts
@@ function second() {
-  return false;
+  return true;
*** End Patch`,
      },
      makeContext()
    );

    expect(await Bun.file(filePath).text()).toBe(
      'function first() {\n  return false;\n}\nfunction second() {\n  return true;\n}\n'
    );
  });

  it('rejects ambiguous context without changing the file', async () => {
    const filePath = await seedAndRead('ambiguous.txt', 'same\nmiddle\nsame\n');

    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Update File: ambiguous.txt
-same
+changed
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toThrow(
      'Hunk 1 for "ambiguous.txt": context matches multiple locations. Add more surrounding context or an @@ marker.'
    );
    expect(await Bun.file(filePath).text()).toBe('same\nmiddle\nsame\n');
  });

  it('names an unlocatable hunk and leaves earlier in-memory hunks unapplied', async () => {
    const filePath = await seedAndRead('missing.txt', 'first\nsecond\n');

    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Update File: missing.txt
-first
+FIRST
@@
-absent
+present
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toThrow(
      'Hunk 2 for "missing.txt": context not found. Re-read the file and regenerate the patch.'
    );
    expect(await Bun.file(filePath).text()).toBe('first\nsecond\n');
  });

  it('requires update and delete targets to be fully read and fresh', async () => {
    const unreadPath = join(tempDir, 'unread.txt');
    await Bun.write(unreadPath, 'unread\n');
    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Update File: unread.txt
-unread
+changed
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toBeInstanceOf(FileNotReadError);
    expect(await Bun.file(unreadPath).text()).toBe('unread\n');

    const stalePath = await seedAndRead('stale.txt', 'before\n');
    await Bun.write(stalePath, 'outside\n');
    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Delete File: stale.txt
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toBeInstanceOf(StaleFileError);
    expect(await Bun.file(stalePath).text()).toBe('outside\n');
  });

  it('writes nothing when any operation fails during planning', async () => {
    const updatePath = await seedAndRead('update.txt', 'before\n');
    await Bun.write(join(tempDir, 'taken.txt'), 'keep\n');

    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Update File: update.txt
-before
+after
*** Add File: new.txt
+new
*** Add File: taken.txt
+overwrite
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toThrow('Add "taken.txt"');

    expect(await Bun.file(updatePath).text()).toBe('before\n');
    expect(existsSync(join(tempDir, 'new.txt'))).toBe(false);
    expect(await Bun.file(join(tempDir, 'taken.txt')).text()).toBe('keep\n');
  });

  it('serializes competing patches so an existing destination is never overwritten', async () => {
    const results = await Promise.allSettled([
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Add File: contested.txt
+first
*** End Patch`,
        },
        makeContext()
      ),
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Add File: contested.txt
+second
*** End Patch`,
        },
        makeContext()
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(['first\n', 'second\n']).toContain(
      await Bun.file(join(tempDir, 'contested.txt')).text()
    );
  });

  it('lists every failing operation in one planning error', async () => {
    await Bun.write(join(tempDir, 'first.txt'), 'keep\n');
    await Bun.write(join(tempDir, 'second.txt'), 'keep\n');

    const error = (await executeApplyPatch(
      {
        patch: `*** Begin Patch
*** Add File: first.txt
+one
*** Add File: second.txt
+two
*** End Patch`,
      },
      makeContext()
    ).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).toContain('Add "first.txt"');
    expect(error.message).toContain('Add "second.txt"');
  });

  it('rejects duplicate or overlapping operation paths before writing', async () => {
    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Add File: duplicate.txt
+one
*** Add File: duplicate.txt
+two
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toThrow('path conflicts with Add "duplicate.txt"');
    expect(existsSync(join(tempDir, 'duplicate.txt'))).toBe(false);
  });

  it('enforces path policy for every source and move destination', async () => {
    await seedAndRead('source.txt', 'before\n');

    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: blocked/moved.txt
-before
+after
*** End Patch`,
        },
        makeContext({ deniedPaths: [join(tempDir, 'blocked')] })
      )
    ).rejects.toThrow('in the denied paths');
    expect(await Bun.file(join(tempDir, 'source.txt')).text()).toBe('before\n');
    expect(existsSync(join(tempDir, 'blocked/moved.txt'))).toBe(false);
  });

  it('rejects paths outside a restricted chat workdir before writing', async () => {
    const outsidePath = join(tmpdir(), `apply-patch-outside-${crypto.randomUUID()}.txt`);
    try {
      await expect(
        executeApplyPatch(
          {
            patch: `*** Begin Patch
*** Add File: ${outsidePath}
+outside
*** End Patch`,
          },
          {
            ...makeContext(),
            workdirPolicy: { root: tempDir, restricted: true },
          }
        )
      ).rejects.toThrow('outside the chat working directory');
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it('refuses patch content that would create a binary file', async () => {
    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Add File: binary.txt
+${'a'.repeat(9_000)}\u0000b
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toThrow('result contains a NUL byte');
    expect(existsSync(join(tempDir, 'binary.txt'))).toBe(false);
  });

  it('refuses to rewrite a non-UTF-8 text file', async () => {
    const filePath = join(tempDir, 'invalid-utf8.txt');
    await Bun.write(filePath, new Uint8Array([0x66, 0x6f, 0x80, 0x6f, 0x0a]));
    await executeReadFile({ path: filePath }, makeContext());

    await expect(
      executeApplyPatch(
        {
          patch: `*** Begin Patch
*** Update File: invalid-utf8.txt
-fo�o
+fixed
*** End Patch`,
        },
        makeContext()
      )
    ).rejects.toThrow('file is not valid UTF-8 text');
    expect(await Bun.file(filePath).bytes()).toEqual(
      new Uint8Array([0x66, 0x6f, 0x80, 0x6f, 0x0a])
    );
  });
});

describe('apply_patch argument handling', () => {
  it('preserves the model patch payload through the registry wrapper', async () => {
    const result = (await executeTool(
      'apply_patch',
      {
        patch: `*** Begin Patch
*** Add File: registry.txt
+line one
+line two
*** End Patch`,
      },
      makeContext()
    )) as { summary: string };

    expect(result.summary).toBe('1 file changed');
    expect(await Bun.file(join(tempDir, 'registry.txt')).text()).toBe('line one\nline two\n');
  });

  it('rejects a missing or non-string patch before writing', async () => {
    await expect(executeTool('apply_patch', {}, makeContext())).rejects.toThrow(
      'Missing required field "patch"'
    );
    await expect(executeTool('apply_patch', { patch: 42 }, makeContext())).rejects.toThrow(
      'Field "patch" must be a string'
    );
  });
});
