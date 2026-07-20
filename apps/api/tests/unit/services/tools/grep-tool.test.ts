import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeGrep,
  GREP_DEFAULT_MAX_FILE_BYTES,
  GREP_DEFAULT_MAX_PER_FILE,
  GREP_DEFAULT_MAX_RESULTS,
  GREP_MAX_MAX_RESULTS,
  GREP_MIN_MAX_RESULTS,
  GrepPatternError,
  normalizeGrepToolSettings,
} from '../../../../src/services/tools/builtin/grep';
import type { ToolContext } from '../../../../src/services/tools/types';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'grep-tool-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters };
}

function seedFile(filePath: string, content: string): Promise<number> {
  return Bun.write(filePath, content);
}

async function seedTree(): Promise<void> {
  await seedFile(
    join(tempDir, 'a.ts'),
    ['// TODO: rewrite', 'export const a = 1;', 'console.log("done");'].join('\n')
  );
  await seedFile(
    join(tempDir, 'b.ts'),
    ['export const TODO_LIST = [];', '// nothing here'].join('\n')
  );
  mkdirSync(join(tempDir, 'nested'));
  await seedFile(join(tempDir, 'nested', 'c.txt'), 'TODO at nested level');
}

describe('normalizeGrepToolSettings', () => {
  it('returns defaults for missing parameters', () => {
    const settings = normalizeGrepToolSettings({});
    expect(settings.maxResults).toBe(GREP_DEFAULT_MAX_RESULTS);
    expect(settings.maxMatchesPerFile).toBe(GREP_DEFAULT_MAX_PER_FILE);
    expect(settings.maxFileSizeBytes).toBe(GREP_DEFAULT_MAX_FILE_BYTES);
    expect(settings.includeDotfiles).toBe(false);
  });

  it('clamps numeric settings to bounds', () => {
    expect(normalizeGrepToolSettings({ maxResults: 0 }).maxResults).toBe(GREP_MIN_MAX_RESULTS);
    expect(normalizeGrepToolSettings({ maxResults: 99_999 }).maxResults).toBe(GREP_MAX_MAX_RESULTS);
  });
});

describe('executeGrep', () => {
  it('returns line matches across files in a directory', async () => {
    await seedTree();
    const result = await executeGrep({ pattern: 'TODO', path: tempDir }, makeContext());

    expect(result.matches.length).toBe(3);
    expect(result.filesScanned).toBeGreaterThanOrEqual(3);
    expect(result.truncated).toBe(false);

    const files = result.matches.map((m) => m.file).sort();
    expect(files).toEqual(['a.ts', 'b.ts', join('nested', 'c.txt')]);

    const lines = result.matches.map((m) => m.line).sort();
    expect(lines).toEqual([1, 1, 1]);
  });

  it('uses the chat workdir when path is omitted', async () => {
    await seedFile(join(tempDir, 'workdir.txt'), 'find this marker');

    const result = await executeGrep({ pattern: 'marker' }, { ...makeContext(), workdir: tempDir });

    expect(result.path).toBe(tempDir);
    expect(result.matches).toHaveLength(1);
  });

  it('respects the glob filter on directory searches', async () => {
    await seedTree();
    const result = await executeGrep(
      { pattern: 'TODO', path: tempDir, glob: '*.ts' },
      makeContext()
    );
    expect(result.matches.every((m) => m.file.endsWith('.ts'))).toBe(true);
    expect(result.matches.some((m) => m.file === join('nested', 'c.txt'))).toBe(false);
  });

  it('searches a single file when path is a file', async () => {
    await seedTree();
    const result = await executeGrep(
      { pattern: 'console', path: join(tempDir, 'a.ts') },
      makeContext()
    );
    expect(result.filesScanned).toBe(1);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.line).toBe(3);
    expect(result.matches[0]?.text).toContain('console.log');
  });

  it('matches case-insensitively when configured', async () => {
    await seedFile(join(tempDir, 'casing.txt'), 'Hello\nhello\nHELLO');
    const result = await executeGrep(
      { pattern: 'hello', path: tempDir, caseInsensitive: true },
      makeContext()
    );
    expect(result.matches).toHaveLength(3);
  });

  it('throws GrepPatternError when the regex is invalid', async () => {
    await seedTree();
    let captured: unknown;
    try {
      await executeGrep({ pattern: '(', path: tempDir }, makeContext());
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(GrepPatternError);
  });

  it('caps total matches with maxResults and reports truncation', async () => {
    for (let i = 0; i < 10; i++) {
      await seedFile(join(tempDir, `f${i}.txt`), 'match-me');
    }
    const result = await executeGrep(
      { pattern: 'match-me', path: tempDir },
      makeContext({ maxResults: 4 })
    );
    expect(result.matches).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });

  it('caps per-file matches with maxMatchesPerFile', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `match-${i}`).join('\n');
    await seedFile(join(tempDir, 'many.txt'), lines);
    const result = await executeGrep(
      { pattern: 'match-', path: tempDir },
      makeContext({ maxMatchesPerFile: 3 })
    );
    expect(result.matches.filter((m) => m.file === 'many.txt')).toHaveLength(3);
  });

  it('skips files larger than maxFileSizeBytes', async () => {
    const big = 'a'.repeat(5000);
    await seedFile(join(tempDir, 'big.txt'), `${big}\nTODO\n`);
    const result = await executeGrep(
      { pattern: 'TODO', path: tempDir },
      makeContext({ maxFileSizeBytes: 1000 })
    );
    expect(result.matches.some((m) => m.file === 'big.txt')).toBe(false);
  });

  it('skips binary files by null-byte sniff', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 0, 4]);
    await Bun.write(join(tempDir, 'data.bin'), bytes);
    await seedFile(join(tempDir, 'data.txt'), 'plain TODO here');
    const result = await executeGrep({ pattern: 'TODO', path: tempDir }, makeContext());
    expect(result.matches.some((m) => m.file === 'data.bin')).toBe(false);
    expect(result.matches.some((m) => m.file === 'data.txt')).toBe(true);
  });

  it('rejects searches outside allowed paths', async () => {
    await seedTree();
    let threw = false;
    try {
      await executeGrep(
        { pattern: 'TODO', path: tempDir },
        makeContext({ allowedPaths: ['/other'] })
      );
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('not in the allowed paths');
    }
    expect(threw).toBe(true);
  });

  it('rejects searches inside denied paths', async () => {
    await seedTree();
    let threw = false;
    try {
      await executeGrep(
        { pattern: 'TODO', path: tempDir },
        makeContext({ deniedPaths: [tempDir] })
      );
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('in the denied paths');
    }
    expect(threw).toBe(true);
  });
});
