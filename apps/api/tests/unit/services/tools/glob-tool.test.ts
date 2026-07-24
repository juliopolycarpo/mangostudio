import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolArgumentError } from '../../../../src/services/tools/arg-parsing';
import {
  executeGlob,
  GLOB_DEFAULT_MAX_RESULTS,
  GLOB_MAX_MAX_RESULTS,
  GLOB_MIN_MAX_RESULTS,
  type GlobToolResult,
  normalizeGlobToolSettings,
  register as registerGlobTool,
} from '../../../../src/services/tools/builtin/glob';
import { executeTool } from '../../../../src/services/tools/registry';
import type { ToolContext } from '../../../../src/services/tools/types';
import { useToolRegistry } from './support/tool-registry-harness';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'glob-tool-test-'));
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
  await seedFile(join(tempDir, 'a.ts'), 'export const a = 1;');
  await seedFile(join(tempDir, 'b.ts'), 'export const b = 2;');
  await seedFile(join(tempDir, 'README.md'), '# title');
  mkdirSync(join(tempDir, 'nested'));
  await seedFile(join(tempDir, 'nested', 'c.ts'), 'export const c = 3;');
  await seedFile(join(tempDir, '.hidden.ts'), '// hidden');
}

describe('normalizeGlobToolSettings', () => {
  it('returns defaults for missing parameters', () => {
    const settings = normalizeGlobToolSettings({});
    expect(settings.allowedPaths).toEqual([]);
    expect(settings.deniedPaths).toEqual([]);
    expect(settings.maxResults).toBe(GLOB_DEFAULT_MAX_RESULTS);
    expect(settings.includeDotfiles).toBe(false);
    expect(settings.absolute).toBe(false);
  });

  it('clamps maxResults to its bounds', () => {
    expect(normalizeGlobToolSettings({ maxResults: 0 }).maxResults).toBe(GLOB_MIN_MAX_RESULTS);
    expect(normalizeGlobToolSettings({ maxResults: 99_999 }).maxResults).toBe(GLOB_MAX_MAX_RESULTS);
  });

  it('rounds fractional maxResults', () => {
    expect(normalizeGlobToolSettings({ maxResults: 12.6 }).maxResults).toBe(13);
  });

  it('falls back to default when maxResults is non-numeric', () => {
    expect(normalizeGlobToolSettings({ maxResults: 'many' }).maxResults).toBe(
      GLOB_DEFAULT_MAX_RESULTS
    );
  });

  it('respects boolean flags', () => {
    const settings = normalizeGlobToolSettings({ includeDotfiles: true, absolute: true });
    expect(settings.includeDotfiles).toBe(true);
    expect(settings.absolute).toBe(true);
  });
});

describe('executeGlob', () => {
  it('drops matches that a traversing pattern pulls outside the workdir', async () => {
    const base = mkdtempSync(join(tmpdir(), 'glob-escape-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      mkdirSync(root);
      mkdirSync(outside);
      await seedFile(join(root, 'inside.txt'), 'ok');
      await seedFile(join(outside, 'secret.txt'), 'SECRET');

      const result = await executeGlob({ pattern: '../outside/*.txt' }, {
        ...makeContext(),
        workdir: root,
        workdirPolicy: { root, restricted: true },
      } as ToolContext);

      expect(result.matches).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('matches files by pattern from the given cwd', async () => {
    await seedTree();
    const result = await executeGlob({ pattern: '**/*.ts', cwd: tempDir }, makeContext());
    const names = result.matches.sort();
    expect(names).toEqual(['a.ts', 'b.ts', join('nested', 'c.ts')]);
    expect(result.truncated).toBe(false);
  });

  it('uses the chat workdir when cwd is omitted', async () => {
    await seedTree();

    const result = await executeGlob({ pattern: '*.md' }, { ...makeContext(), workdir: tempDir });

    expect(result.matches).toEqual(['README.md']);
  });

  it('resolves an explicit relative cwd from the chat workdir', async () => {
    await seedTree();

    const result = await executeGlob(
      { pattern: '*.ts', cwd: 'nested' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result.matches).toEqual(['c.ts']);
  });

  it('reports an absolute cwd so the model can feed it back verbatim', async () => {
    await seedTree();

    const first = await executeGlob(
      { pattern: '*.ts', cwd: 'nested' },
      { ...makeContext(), workdir: tempDir }
    );
    expect(first.cwd).toBe(join(tempDir, 'nested'));

    const second = await executeGlob(
      { pattern: '*.ts', cwd: first.cwd },
      { ...makeContext(), workdir: tempDir }
    );
    expect(second.matches).toEqual(first.matches);
  });

  it('falls back to the chat workdir when cwd is blank', async () => {
    await seedTree();

    const result = await executeGlob(
      { pattern: '*.ts', cwd: '   ' },
      { ...makeContext(), workdir: tempDir }
    );

    expect(result.cwd).toBe(tempDir);
    expect(result.matches.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('skips dotfiles by default and includes them when enabled', async () => {
    await seedTree();
    const without = await executeGlob({ pattern: '*.ts', cwd: tempDir }, makeContext());
    expect(without.matches).not.toContain('.hidden.ts');

    const withDot = await executeGlob(
      { pattern: '*.ts', cwd: tempDir },
      makeContext({ includeDotfiles: true })
    );
    expect(withDot.matches).toContain('.hidden.ts');
  });

  it('truncates when results exceed maxResults', async () => {
    for (let i = 0; i < 5; i++) {
      await seedFile(join(tempDir, `f${i}.txt`), 'x');
    }
    const result = await executeGlob(
      { pattern: '*.txt', cwd: tempDir },
      makeContext({ maxResults: 2 })
    );
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('returns absolute paths when configured', async () => {
    await seedTree();
    const result = await executeGlob(
      { pattern: '*.ts', cwd: tempDir },
      makeContext({ absolute: true })
    );
    for (const match of result.matches) {
      expect(match.startsWith(tempDir)).toBe(true);
    }
  });

  it('rejects cwd outside allowed paths', async () => {
    await seedTree();
    let threw = false;
    try {
      await executeGlob(
        { pattern: '*.ts', cwd: tempDir },
        makeContext({ allowedPaths: ['/other'] })
      );
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('not in the allowed paths');
    }
    expect(threw).toBe(true);
  });

  it('rejects cwd inside denied paths', async () => {
    await seedTree();
    let threw = false;
    try {
      await executeGlob({ pattern: '*.ts', cwd: tempDir }, makeContext({ deniedPaths: [tempDir] }));
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('in the denied paths');
    }
    expect(threw).toBe(true);
  });

  it('expands ~ in cwd', async () => {
    await seedTree();
    const originalHome = Bun.env.HOME;
    Bun.env.HOME = tempDir;
    try {
      const result = await executeGlob({ pattern: '*.ts', cwd: '~' }, makeContext());
      expect(result.matches.sort()).toEqual(['a.ts', 'b.ts']);
    } finally {
      Bun.env.HOME = originalHome;
    }
  });

  it('returns no matches when nothing matches the pattern', async () => {
    await seedTree();
    const result = await executeGlob({ pattern: '*.zzz', cwd: tempDir }, makeContext());
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe('glob registry contract', () => {
  const harness = useToolRegistry('glob-registry', registerGlobTool);

  function runGlob(args: Record<string, unknown>): Promise<GlobToolResult> {
    return executeTool('glob', args, harness.context()) as Promise<GlobToolResult>;
  }

  beforeEach(async () => {
    await seedFile(harness.path('a.ts'), 'export const a = 1;');
    await seedFile(harness.path('README.md'), '# title');
    mkdirSync(harness.path('nested'));
    await seedFile(harness.path('nested', 'b.ts'), 'export const b = 2;');
  });

  it('rejects a missing pattern', async () => {
    await expect(runGlob({})).rejects.toThrow('Missing required field "pattern".');
  });

  for (const [label, value] of [
    ['a number', 42],
    ['null', null],
    ['a boolean', true],
    ['an object', {}],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ] as const) {
    it(`rejects ${label} pattern with the missing-field error, not a TypeError`, async () => {
      const error = await runGlob({ pattern: value }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ToolArgumentError);
      expect((error as Error).message).toBe('Missing required field "pattern".');
    });
  }

  it('defaults cwd to the chat workdir when it is absent', async () => {
    const result = await runGlob({ pattern: '**/*.ts' });

    expect(result.cwd).toBe(harness.dir);
    expect(result.matches.sort()).toEqual(['a.ts', 'nested/b.ts']);
  });

  it('resolves an explicit relative cwd against the chat workdir', async () => {
    const result = await runGlob({ pattern: '*.ts', cwd: 'nested' });

    expect(result.cwd).toBe(harness.path('nested'));
    expect(result.matches).toEqual(['b.ts']);
  });

  for (const [label, value] of [
    ['a number', 42],
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ] as const) {
    it(`treats ${label} cwd as absent and searches the chat workdir`, async () => {
      const result = await runGlob({ pattern: '*.ts', cwd: value });

      expect(result.cwd).toBe(harness.dir);
      expect(result.matches).toEqual(['a.ts']);
    });
  }

  it('trims a padded pattern, because a glob has no meaningful edge whitespace', async () => {
    const result = await runGlob({ pattern: '  *.ts  ' });

    expect(result.pattern).toBe('*.ts');
    expect(result.matches).toEqual(['a.ts']);
  });
});
